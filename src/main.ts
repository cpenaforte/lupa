import * as core from "@actions/core";
import { pathToFileURL } from "node:url";
import { run } from "./application/run.js";
import { readRunEnv } from "./platform/action-env.js";
import { createGateway } from "./platform/github-gateway.js";
import { createAnalysis } from "./platform/analysis-services.js";

export type { RunEnv, PrInfo, Gateway, Analysis, Deps, Outcome } from "./application/contracts.js";
export { run } from "./application/run.js";
export { readRunEnv } from "./platform/action-env.js";
export { cleanEnvForExec } from "./application/analyze.js";
export { sanitizeFinding } from "./domain/finding.js";
export { parseDiffFiles, unquoteGitPath } from "./diff/patch.js";
export { readFindings } from "./artifacts/review-store.js";
export { budgetPrompt } from "./prompt/budget.js";
export { toSarif } from "./review/render.js";

export async function main(): Promise<void> {
  const env = readRunEnv();
  const out = await run(env, { gh: createGateway(env.inputs.githubToken, { trustedLogin: env.inputs.reviewActor }), analysis: createAnalysis() });
  core.setOutput("exit-code", String(out.exitCode));
  process.exitCode = out.exitCode;
}

const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  main().catch((err: unknown) => {
    core.setFailed(err instanceof Error ? err.message : String(err));
  });
}
