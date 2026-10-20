import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunEnv } from "../application/contracts.js";
import { getInputs } from "../inputs.js";

/** Reads the real environment. Throws on invalid action inputs. */
export function readRunEnv(): RunEnv {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const payload: Record<string, unknown> =
    eventPath !== undefined && eventPath !== ""
      ? (JSON.parse(readFileSync(eventPath, "utf8")) as Record<string, unknown>)
      : {};
  const inputs = getInputs();
  const value = process.env.PR_REVIEWER_TOKEN_TYPE;
  const tokenType = value === 'app' ? 'app' : value === 'workflow-run' ? 'workflow-run' : 'github-token';
  return {
    eventName: process.env.GITHUB_EVENT_NAME ?? "",
    payload,
    inputs,
    workDir: process.env.GITHUB_WORKSPACE ?? process.cwd(),
    artifactDir: process.env.PR_REVIEWER_ARTIFACT_DIR ?? join(process.env.RUNNER_TEMP ?? tmpdir(), "pr-reviewer-out"),
    baseSha: process.env.PR_REVIEWER_BASE_SHA ?? "",
    headSha: process.env.PR_REVIEWER_HEAD_SHA ?? "",
    tokenType,
    issueFallback: process.env.PR_REVIEWER_ISSUE_FALLBACK === "true",
    ...(process.env.GITHUB_STEP_SUMMARY ? { summaryPath: process.env.GITHUB_STEP_SUMMARY } : {}),
  };
}
