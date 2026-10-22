import * as core from "@actions/core";
import { copyFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { RunEnv, Deps, Outcome, EventFields } from "./contracts.js";
import type { Finding } from "../domain/finding.js";
import { sanitizeFinding } from "../domain/finding.js";
import type { PrMeta } from "../domain/diff.js";
import type { AnalysisAssessment } from "../domain/assessment.js";
import { assessmentExit } from "../domain/assessment.js";
import { projectDiff, finalizeAssessment } from "../analysis/coverage.js";
import type { DedupVerdicts } from "../llm/types.js";
import { runL0 } from "../fastpath.js";
import { isLockfile, parsePatch, PER_FILE_CAP } from "../diff/patch.js";
import { readDiff, writeFindings, writePrMeta, writeAssessment } from "../artifacts/review-store.js";
import { resolvePrNumber, shouldTrigger } from "../github.js";
import { linkedIssueNumber } from "../prompt.js";
import { redactFindings, toSarif } from "../review/render.js";
import { mergeDuplicates } from "../review/grouping.js";
import { exitFor } from "../review/policy.js";
import { slowPath } from "./slow-path.js";
import { note, publishReview, runtimeSecrets } from "./publish.js";
import { cleanEnvForExec } from "../runtime/exec-env.js";
export { cleanEnvForExec } from "../runtime/exec-env.js";

const SHA_RE = /^[0-9a-f]{40}$/;

/** Emitted in place of L2 execution on fork PRs with secrets in scope. */
const L2_SKIPPED: Finding = {
  severity: "info",
  file: "",
  rule: "l2-skipped",
  message:
    "L2 native toolchains were not executed: fork PR with secrets in scope. Semgrep, gitleaks and trivy still ran.",
  source: "l2",
};

/** Lockfile basename to the manifest that must change with it. Unmapped lockfiles are not flagged. */
const MANIFEST_FOR: Readonly<Record<string, string>> = {
  "package-lock.json": "package.json",
  "npm-shrinkwrap.json": "package.json",
  "pnpm-lock.yaml": "package.json",
  "yarn.lock": "package.json",
  "bun.lock": "package.json",
  "bun.lockb": "package.json",
  "Cargo.lock": "Cargo.toml",
  "go.sum": "go.mod",
  "Gemfile.lock": "Gemfile",
  "poetry.lock": "pyproject.toml",
  "uv.lock": "pyproject.toml",
  "Pipfile.lock": "Pipfile",
  "composer.lock": "composer.json",
  "pubspec.lock": "pubspec.yaml",
  "Podfile.lock": "Podfile",
  "flake.lock": "flake.nix",
};

function requireSha(name: string, value: string): void {
  if (!SHA_RE.test(value)) throw new Error(`lupa: ${name} must be a 40-character lowercase commit SHA`);
}

function fields(env: RunEnv): EventFields {
  return env.payload as EventFields;
}

function triggerFor(env: RunEnv): boolean {
  const p = fields(env);
  return shouldTrigger(env.eventName, {
    action: p.action,
    commentBody: p.comment?.body,
    reviewBody: p.review?.body,
    authorAssociation: p.comment?.author_association ?? p.review?.author_association,
    issueHasPR: p.issue?.pull_request !== undefined,
    prNumber: env.inputs.prNumber,
  });
}

function prNumberFor(env: RunEnv): number | null {
  if (env.eventName === "workflow_dispatch") return env.inputs.prNumber;
  return resolvePrNumber(env.eventName, env.payload as Parameters<typeof resolvePrNumber>[1]);
}

/** Fluxo A: pull_request / issue_comment / review / dispatch. The diff comes from the template. */
export async function runAnalysisFlow(env: RunEnv, deps: Deps, out: Outcome): Promise<void> {
  out.slowPathSkipped = true;
  const assessment: AnalysisAssessment = { version: 1, baseSha: env.baseSha, headSha: env.headSha,
    policy: env.inputs.analysisPolicy ?? "advisory", scope: env.inputs.analysisPolicy === "required" || env.inputs.llmApiKey !== "" ? "semantic" : "deterministic",
    status: "skipped", stages: [], coverage: { filesTotal: 0, hunksTotal: 0, filesReviewed: 0, hunksReviewed: 0, issues: [], issuesOmitted: 0 } };
  out.analysis = assessment;
  if (!triggerFor(env)) {
    note(env, out, `lupa: event "${env.eventName}" does not trigger a review; nothing to do.`);
    return;
  }
  const pr = prNumberFor(env);
  if (pr === null) {
    note(env, out, "lupa: no pull request for this event; nothing to review.");
    return;
  }
  requireSha("PR_REVIEWER_BASE_SHA", env.baseSha);
  requireSha("PR_REVIEWER_HEAD_SHA", env.headSha);

  // Unfiltered list: L0 needs lockfiles and binaries (Task 4 contract).
  const { files, issues } = parsePatch(readDiff(env.artifactDir), env.workDir);
  const patchWarnings: Finding[] = issues.length === 0 ? [] : [{
    severity: "warning", file: "", rule: "diff-unparsed",
    message: `${issues.length} patch section(s) could not be attributed to a file; review coverage is incomplete.`,
  }];
  for (const warning of patchWarnings) core.warning(`${warning.rule}: ${warning.message}`);
  const pull = await deps.gh.getPr(pr);
  const meta: PrMeta = {
    pr_number: pr,
    head_sha: env.headSha,
    base_sha: env.baseSha,
    head_repo_full_name: pull.headRepo,
    is_fork: pull.isFork,
  };
  writePrMeta(meta, env.artifactDir);
  const prompt = projectDiff(files, env.inputs.maxDiffChars, PER_FILE_CAP);
  assessment.status = "incomplete";
  assessment.coverage = { ...assessment.coverage, filesTotal: prompt.eligibleFiles, hunksTotal: prompt.eligibleHunks,
    issues: [...prompt.issues, ...issues.map(i => ({ code: "patch-unparsed", message: i.message }))] };
  if (prompt.issues.some(i => i.code === "unsupported-path")) assessment.stages.push({ stage: "filtered-paths", required: true, applicable: true, status: "unsupported", reason: "content-without-analyzer" });
  assessment.stages.push({ stage: "analysis", required: true, applicable: true, status: "skipped", reason: "execution-pending" });
  writeAssessment(env.artifactDir, assessment, env.inputs.maxArtifactBytes, runtimeSecrets(env));

  const changedNames = new Set(files.map((f) => basename(f.file)));
  const l0 = runL0(files, {
    hasManifestFor: (lock) => {
      const manifest = MANIFEST_FOR[lock];
      return manifest === undefined || changedNames.has(manifest);
    },
  });
  const lockfiles = files.filter((f) => isLockfile(f.file)).map((f) => f.file);

  // Scanners and L2 run PR-controlled code: scrubbed env. The semgrep token is never passed
  // here, so semgrep always runs in `scan` mode (a secret never reaches PR code).
  // Fork PR with secrets in scope (non-pull_request trigger, writable App token, or LLM key):
  // L2 toolchains (linters, build tooling) would execute PR-controlled config with secrets nearby,
  // so they are skipped. Trusted, data-driven scanners still run.
  const forkWithSecrets =
    pull.isFork && (env.eventName !== "pull_request" || env.tokenType === "app" || env.inputs.llmApiKey !== "");
  const execution = { env: cleanEnvForExec(process.env) };
  const { scan, l2 } = await (async () => {
    const s = await deps.analysis.runScanners({
      dir: env.workDir,
      baselineSha: env.baseSha,
      hasSemgrepToken: false,
      sbom: true,
      lockfiles,
      outDir: env.artifactDir,
      maxArtifactBytes: env.inputs.maxArtifactBytes,
    }, execution);
    if (forkWithSecrets) {
      core.warning("fork PR with secrets in scope: L2 native toolchains skipped");
      assessment.stages.push({ stage: "l2", applicable: true, required: true, status: "skipped", reason: "fork-with-secrets" });
      return { scan: s, l2: [L2_SKIPPED] };
    }
    if (deps.analysis.runL2Detailed) {
      const l = await deps.analysis.runL2Detailed(env.workDir, new Set(files.map(f => f.file)), execution);
      assessment.stages.push(...l.stages);
      return { scan: s, l2: l.findings };
    }
    const l = await deps.analysis.runL2(env.workDir, new Set(files.map(f => f.file)), execution);
    assessment.stages.push({ stage: "l2", applicable: true, required: true, status: "unsupported", reason: "unknown-health" });
    return { scan: s, l2: l };
  })();
  const expectedScanners = ["semgrep", "gitleaks", "trivy", ...(lockfiles.length ? ["osv-scanner"] : [])];
  assessment.stages.push(...(scan.stages ?? []));
  for (const stage of expectedScanners) if (!scan.stages?.some(s => s.stage === stage)) {
    assessment.stages.push({ stage, applicable: true, required: true, status: "unsupported", reason: "unknown-health" });
  }
  if (scan.sbomPath !== undefined) {
    try {
      copyFileSync(scan.sbomPath, join(env.artifactDir, "sbom.cdx.json"));
    } catch (e) {
      core.warning(`sbom not copied to the artifact: ${(e as Error).message}`);
    } finally {
      rmSync(dirname(scan.sbomPath), { recursive: true, force: true });
    }
  }
  const fast = [...patchWarnings, ...l0, ...scan.findings, ...l2];
  // Written before the LLM call so a later failure still leaves the fast results uploadable.
  writeFindings(env.artifactDir, redactFindings(fast, runtimeSecrets(env)));

  let issueBody: string | undefined;
  const issueNo = linkedIssueNumber(pull.body);
  if (issueNo !== null) {
    try {
      issueBody = await deps.gh.getIssueBody(issueNo);
      out.issueBodyFetched = issueNo;
    } catch (e) {
      if (assessment.scope === "semantic") assessment.coverage.issues.push({ code: "issue-context", message: `Linked issue #${issueNo} could not be fetched.` });
      core.warning(`linked issue #${issueNo} not fetched: ${(e as Error).message}`);
    }
  }

  const llm = await slowPath(env, out, deps, pr, fast, prompt.text, issueBody, prompt.skipped, pull.body, assessment);
  assessment.stages = assessment.stages.filter(s => s.stage !== "analysis");
  if (assessment.stages.some(s => s.stage === "semantic" && s.status === "ok")) {
    assessment.coverage.filesReviewed = prompt.includedFiles;
    assessment.coverage.hunksReviewed = prompt.includedHunks;
  }
  if (llm === undefined) {
    note(env, out, "lupa: dedup skipped (slow path unavailable); scanner findings published unmerged");
  }
  out.slowPathSkipped = llm === undefined;
  out.findingsFrom = llm === undefined ? "fastpath" : "llm";
  // No judge ran (no LLM): the verdicts key still lands on pr-meta as the empty object.
  // Agent runs carry no verdicts and merge nothing, by design.
  const verdicts: DedupVerdicts | undefined =
    llm === undefined ? { pairs: [], links: [], malformed: 0 } : llm.verdicts;
  const all = [...fast, ...(llm?.findings ?? [])].map(sanitizeFinding);
  const redacted = redactFindings(all, runtimeSecrets(env));
  writeFindings(env.artifactDir, redacted);
  writePrMeta(verdicts === undefined ? meta : { ...meta, verdicts }, env.artifactDir);
  // SARIF is a publication surface: the same pure merge over the same inputs as the funnel.
  const { merged: sarifSet } = verdicts === undefined ? { merged: redacted } : mergeDuplicates(redacted, verdicts);
  writeFileSync(join(env.artifactDir, "sarif.json"), JSON.stringify(toSarif(sarifSet), null, 2) + "\n", "utf8");

  const result = await publishReview({ env, deps, out, pr, isFork: pull.isFork, findings: all, hunks: files, headSha: env.headSha, verdicts, assessment: finalizeAssessment(assessment) });
  out.exitCode = assessmentExit(env.inputs.analysisPolicy, result.assessment.status, out.staleSkipped ? 0 : exitFor(env.inputs.failLevel, result.blocking));
}
