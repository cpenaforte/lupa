import * as core from "@actions/core";
import { copyFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { RunEnv, Deps, Outcome, EventFields } from "./contracts.js";
import type { Finding } from "../domain/finding.js";
import { sanitizeFinding } from "../domain/finding.js";
import type { PrMeta } from "../domain/diff.js";
import type { DedupVerdicts } from "../llm/types.js";
import { runL0 } from "../fastpath.js";
import { filterForPrompt, isLockfile, parseDiffFiles, PER_FILE_CAP, truncateDiff } from "../diff/patch.js";
import { readDiff, writeFindings, writePrMeta } from "../artifacts/review-store.js";
import { resolvePrNumber, shouldTrigger } from "../github.js";
import { linkedIssueNumber } from "../prompt.js";
import { redactFindings, toSarif } from "../review/render.js";
import { mergeDuplicates } from "../review/grouping.js";
import { exitFor } from "../review/policy.js";
import { slowPath } from "./slow-path.js";
import { note, publishReview, runtimeSecrets } from "./publish.js";

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

// ---------------------------------------------------------------------------
// Exec environment scrubbing (R1). Scanners and linters run PR-controlled code
// (build scripts, configs), so they must not inherit secrets.
// ---------------------------------------------------------------------------

const EXEC_ALLOW: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "LC_ALL",
  "TZ",
  "TMPDIR",
  "GITHUB_WORKSPACE",
  "SYSTEMROOT",
  "PATHEXT",
  "DOCKER_HOST",
]);
const EXEC_ALLOW_PREFIX = ["RUNNER_"];
/** Deny wins over the allowlist. */
const EXEC_DENY = /TOKEN|KEY|SECRET|PASSWORD|AUTH|^GITHUB_TOKEN$|^ACTIONS_/i;

/** The environment handed to PR-controlled exec: allowlisted names only, never secret-shaped names. */
export function cleanEnvForExec(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || EXEC_DENY.test(k)) continue;
    if (EXEC_ALLOW.has(k) || EXEC_ALLOW_PREFIX.some((p) => k.startsWith(p))) out[k] = v;
  }
  return out;
}

/**
 * Runs `fn` with process.env replaced by the scrubbed exec env. Scanners and L2 spawn children
 * that inherit process.env at spawn time, so the swap reaches them without changing their modules.
 * Restored in `finally`. Calls are sequential in run(), so the window never overlaps another call.
 */
async function withScrubbedEnv<T>(fn: () => Promise<T>): Promise<T> {
  const saved: NodeJS.ProcessEnv = { ...process.env };
  const clean = cleanEnvForExec(saved);
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, clean);
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

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
  const files = parseDiffFiles(readDiff(env.artifactDir), env.workDir);
  const pull = await deps.gh.getPr(pr);
  const meta: PrMeta = {
    pr_number: pr,
    head_sha: env.headSha,
    base_sha: env.baseSha,
    head_repo_full_name: pull.headRepo,
    is_fork: pull.isFork,
  };
  writePrMeta(meta, env.artifactDir);

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
  const { scan, l2 } = await withScrubbedEnv(async () => {
    const s = await deps.analysis.runScanners({
      dir: env.workDir,
      baselineSha: env.baseSha,
      hasSemgrepToken: false,
      sbom: true,
      lockfiles,
      outDir: env.artifactDir,
      maxArtifactBytes: env.inputs.maxArtifactBytes,
    });
    if (forkWithSecrets) {
      core.warning("fork PR with secrets in scope: L2 native toolchains skipped");
      return { scan: s, l2: [L2_SKIPPED] };
    }
    const l = await deps.analysis.runL2(env.workDir, new Set(files.map((f) => f.file)));
    return { scan: s, l2: l };
  });
  if (scan.sbomPath !== undefined) {
    try {
      copyFileSync(scan.sbomPath, join(env.artifactDir, "sbom.cdx.json"));
    } catch (e) {
      core.warning(`sbom not copied to the artifact: ${(e as Error).message}`);
    } finally {
      rmSync(dirname(scan.sbomPath), { recursive: true, force: true });
    }
  }
  const fast = [...l0, ...scan.findings, ...l2];
  // Written before the LLM call so a later failure still leaves the fast results uploadable.
  writeFindings(env.artifactDir, redactFindings(fast, runtimeSecrets(env)));

  const prompt = truncateDiff(filterForPrompt(files), env.inputs.maxDiffChars, PER_FILE_CAP);
  let issueBody: string | undefined;
  const issueNo = linkedIssueNumber(pull.body);
  if (issueNo !== null) {
    try {
      issueBody = await deps.gh.getIssueBody(issueNo);
      out.issueBodyFetched = issueNo;
    } catch (e) {
      core.warning(`linked issue #${issueNo} not fetched: ${(e as Error).message}`);
    }
  }

  const llm = await slowPath(env, out, deps, pr, fast, prompt.text, issueBody, prompt.skipped, pull.body);
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

  const { blocking } = await publishReview({ env, deps, out, pr, isFork: pull.isFork, findings: all, hunks: files, headSha: env.headSha, verdicts });
  if (!out.staleSkipped) out.exitCode = exitFor(env.inputs.failLevel, blocking);
}
