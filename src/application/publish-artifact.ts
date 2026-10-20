import type { RunEnv, Deps, Outcome, EventFields } from "./contracts.js";
import { sanitizeFinding } from "../domain/finding.js";
import { readDiff, readFindings, readPrMeta } from "../artifacts/review-store.js";
import { parseDiffFiles } from "../diff/patch.js";
import { exitFor } from "../review/policy.js";
import { publishReview } from "./publish.js";

function fields(env: RunEnv): EventFields {
  return env.payload as EventFields;
}

/**
 * Fluxo B: workflow_run, privileged. Only reads the PR run's artifact and posts. It never checks
 * out code, runs scanners or calls the LLM. The artifact came from a run that executed PR code,
 * so it is bound to the trusted workflow_run fields and to the live PR (repo, head SHA, branch).
 */
export async function runArtifactFlow(env: RunEnv, deps: Deps, out: Outcome): Promise<void> {
  out.slowPathSkipped = true;
  // Sanitizing pass for the privileged flow (Flow A sanitizes in runAnalysisFlow; publishReview does not sanitize).
  const meta = readPrMeta(env.artifactDir, env.inputs.maxArtifactBytes);
  if (meta === undefined) {
    throw new Error(
      `lupa: pr-meta.json not found in ${env.artifactDir}; refusing to post without the PR run's artifact`,
    );
  }
  const wr = fields(env).workflow_run;
  const runRepo = wr?.head_repository?.full_name;
  const runBranch = wr?.head_branch;
  if (wr?.head_sha === undefined || runRepo === undefined || runRepo === "" || runBranch === undefined) {
    throw new Error("lupa: workflow_run head context is incomplete; refusing to post");
  }
  // Lowercase at the binding site: readPrMeta accepts either case, the API returns lowercase.
  const headSha = meta.head_sha.toLowerCase();
  if (headSha !== wr.head_sha.toLowerCase()) {
    throw new Error("lupa: artifact head_sha does not match workflow_run.head_sha; refusing to post");
  }
  // The PR comes from trusted event fields, never from the artifact: exactly one open PR must
  // have this head (repo + branch), and the artifact's pr_number must name that same PR.
  const prs = await deps.gh.findPrsByHead(runRepo, runBranch);
  if (prs.length !== 1) {
    throw new Error(
      `lupa: expected exactly one open PR for ${runRepo}:${runBranch}, found ${prs.length}; refusing to post`,
    );
  }
  const pr = prs[0];
  if (pr !== meta.pr_number) {
    throw new Error("lupa: artifact pr_number does not match the PR derived from workflow_run; refusing to post");
  }
  const live = await deps.gh.getPr(pr);
  if (live.headRepo !== runRepo) {
    throw new Error("lupa: PR head repository does not match workflow_run.head_repository; refusing to post");
  }
  if (live.headSha.toLowerCase() !== headSha) {
    throw new Error("lupa: live PR head does not match workflow_run.head_sha; refusing to post");
  }
  if (live.headRef !== runBranch) {
    throw new Error("lupa: PR head branch does not match workflow_run.head_branch; refusing to post");
  }
  const findings = readFindings(env.artifactDir, env.inputs.maxArtifactBytes).map(sanitizeFinding);
  const hunks = parseDiffFiles(readDiff(env.artifactDir));
  // A missing verdicts key means no judge ran: silent no-merge. Out-of-range indices
  // range-check inside the publishReview merge (dropped with the count).
  const { blocking } = await publishReview({ env, deps, out, pr, isFork: live.isFork, findings, hunks, headSha, verdicts: meta.verdicts });
  if (!out.staleSkipped) out.exitCode = exitFor(env.inputs.failLevel, blocking);
}
