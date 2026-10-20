import { afterEach, describe, expect, it } from "vitest";
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
      const result = await runSourceEval(testCase, run, analysis);
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
