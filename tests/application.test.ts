import * as core from "@actions/core";
import { afterEach, describe, expect, it, vi } from "vitest";

// Source-corpus runs execute the real publication code, which logs synthetic warnings/errors for
// refusal, stale, and fallback scenarios. Capture them here so they are asserted rather than printed.
vi.mock("@actions/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@actions/core")>();
  return { ...actual, info: vi.fn(), warning: vi.fn(), error: vi.fn() };
});
import { run } from "../src/application/run.js";
import type { Analysis } from "../src/application/contracts.js";
import * as main from "../src/main.js";
import { budgetPrompt } from "../src/prompt/budget.js";
import { parseDiffFiles, unquoteGitPath } from "../src/diff/patch.js";
import { readFindings, readPrMeta, writePrMeta } from "../src/artifacts/review-store.js";
import { toSarif } from "../src/review/render.js";
import * as diff from "../src/diff.js";
import { readRunEnv } from "../src/platform/action-env.js";
import { cleanupEvalRuns, runSourceEval } from "./evals/harness.js";
import { evalCases } from "./evals/corpus.js";

afterEach(cleanupEvalRuns);

type Diagnostic = { level: "info" | "warning" | "error"; message: string };

async function withDiagnostics<T>(fn: () => Promise<T>): Promise<{ result: T; diagnostics: Diagnostic[] }> {
  const diagnostics: Diagnostic[] = [];
  const levels = ["info", "warning", "error"] as const;
  for (const level of levels) {
    vi.mocked(core[level]).mockImplementation((message: string | Error) => { diagnostics.push({ level, message: String(message) }); });
  }
  try {
    return { result: await fn(), diagnostics };
  } finally {
    for (const level of levels) vi.mocked(core[level]).mockReset();
  }
}

const HEAD = "a".repeat(40);
const OTHER = "c".repeat(40);
const STALE_COVERAGE = "Analysis\\: incomplete\\; scope\\: semantic\\.\nSemantic coverage\\: 1\\/1 files\\, 1\\/1 hunks\\; 0 unreviewed hunks\\.\nstale\\-head\\: The PR head changed\\; analysis applies only to the recorded head\\.";
const expectedDiagnostics: Record<string, Diagnostic[]> = {
  "synthetic-force-push-head-moves-before-post": [
    { level: "info", message: STALE_COVERAGE },
    { level: "warning", message: `PR head moved from ${HEAD} to ${OTHER}: skipping review for the stale head` },
  ],
  "synthetic-fork-readonly-summary-only": [
    { level: "warning", message: "fork PR with secrets in scope: L2 native toolchains skipped" },
    { level: "warning", message: "fork PR with a read-only token: review not posted; summary and artifact only" },
  ],
  "synthetic-dry-run-post-comment-off": [
    { level: "info", message: "post_comment is false: dry-run, nothing posted (would post event=COMMENT, inline=1, general=0, high=0, blocking=1, omitted=0)" },
  ],
  "synthetic-non-trigger-push-event": [
    { level: "info", message: 'lupa: event "push" does not trigger a review; nothing to do.' },
  ],
  "synthetic-issue-fallback-after-refusal": [
    { level: "error", message: "review post refused by GitHub: refused" },
  ],
  "synthetic-llm-failure-fast-only": [
    { level: "warning", message: "slow path failed (content-filter): synthetic refusal" },
    { level: "info", message: "lupa: dedup skipped (slow path unavailable); scanner findings published unmerged" },
  ],
  "synthetic-stale-on-post-skip": [
    { level: "info", message: STALE_COVERAGE },
    { level: "info", message: `lupa: PR head moved during posting; analyzed ${HEAD}, live ${OTHER}; skipping review for the stale head — a fresh run will cover the new head.` },
  ],
};

describe("application entry boundary", () => {
  it("preserves the public entry and helper identities across compatibility exports", () => {
    expect(main.run).toBe(run);
    expect(main.budgetPrompt).toBe(budgetPrompt);
    expect(main.parseDiffFiles).toBe(parseDiffFiles);
    expect(main.unquoteGitPath).toBe(unquoteGitPath);
    expect(main.readFindings).toBe(readFindings);
    expect(main.toSarif).toBe(toSarif);
    expect(main.readRunEnv).toBe(readRunEnv);
    expect(diff.readPrMeta).toBe(readPrMeta);
    expect(diff.writePrMeta).toBe(writePrMeta);
  });

  it.each(evalCases.map((testCase) => [testCase.id, testCase] as const))(
    "preserves the existing fixture outcome through application.run: %s",
    async (_id, testCase) => {
      const forbidden = async (): Promise<never> => { throw new Error("Flow B invoked Analysis"); };
      const analysis: Analysis | undefined = testCase.eventOverride?.eventName === "workflow_run" ? {
        runScanners: forbidden, runL2: forbidden, ensureOllama: forbidden, checkModelListed: forbidden,
        callByStyle: forbidden, callWithProbe: forbidden, callByStyleAgent: forbidden, callWithProbeAgent: forbidden,
      } : undefined;
      const { result, diagnostics } = await withDiagnostics(() => runSourceEval(testCase, run, analysis));
      expect(diagnostics).toEqual(expectedDiagnostics[testCase.id] ?? []);
      expect(result.outcome.exitCode).toBe(testCase.expected.exitCode);
      expect(result.findings).toEqual(testCase.expected.findings);
      expect(result.summary).toBe(testCase.expected.summary);
      const publication = testCase.expected.publication;
      expect(result.publications).toEqual(
        publication.kind === "review" ? [{ path: "review", pr: 17, payload: publication.payload }] :
        publication.kind === "issue-comment" ? [{ path: "issue-comment", pr: 17, body: publication.body }] : [],
      );
      if (analysis) expect(result.analysisCalls).toEqual([]);
    },
  );
});
