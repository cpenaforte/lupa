import type { RunEnv, Deps, Outcome } from "./contracts.js";
import { runAnalysisFlow } from "./analyze.js";
import { runArtifactFlow } from "./publish-artifact.js";

function newOutcome(): Outcome {
  return { posted: false, summaryWritten: false, exitCode: 0, findingsFrom: "fastpath", slowPathSkipped: false };
}

/** Runs one review. Returns the outcome; main() maps exitCode to the process. */
export async function run(env: RunEnv, deps: Deps): Promise<Outcome> {
  const out = newOutcome();
  if (env.eventName === "workflow_run") await runArtifactFlow(env, deps, out);
  else await runAnalysisFlow(env, deps, out);
  return out;
}
