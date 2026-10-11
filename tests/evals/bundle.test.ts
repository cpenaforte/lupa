import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { evalCases } from "./corpus.js";
import { cleanupEvalRuns, runBundleEval } from "./harness.js";
import type { EvalCase, EvalRun } from "./types.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  cleanupEvalRuns();
  vi.unstubAllGlobals();
});

function assertCommonCaseContract(testCase: EvalCase, result: EvalRun): void {
  expect(result.prompts.user).toContain(testCase.expected.promptDiffSnippet);
  expect(result.findings).toEqual(testCase.expected.findings);
  expect(result.outcome.exitCode).toBe(testCase.expected.exitCode);
  expect(result.summary).toBe(testCase.expected.summary);
  if (testCase.expected.publication.kind === "review") {
    expect(result.publications).toEqual([{ path: "review", pr: 17, payload: testCase.expected.publication.payload }]);
    for (const finding of testCase.expected.findings) {
      if (finding.line !== undefined) {
        expect(testCase.expected.publication.payload.comments).toContainEqual(
          expect.objectContaining({ path: finding.file, line: finding.line, side: "RIGHT" }),
        );
      }
    }
  } else if (testCase.expected.publication.kind === "issue-comment") {
    expect(result.publications).toEqual([{ path: "issue-comment", pr: 17, body: testCase.expected.publication.body }]);
  } else {
    expect(result.publications).toEqual([]);
  }
}

describe("synthetic bundle regression cases", () => {
  it.each(evalCases.map((testCase) => [testCase.id, testCase] as const))("%s", async (_id, testCase) => {
    const fetchMock = vi.fn(() => { throw new Error("unexpected network request in synthetic evaluation"); });
    vi.stubGlobal("fetch", fetchMock);
    const result = await runBundleEval(testCase);
    assertCommonCaseContract(testCase, result);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("imports the bundle for a push event without launching main", () => {
    const root = mkdtempSync(join(tmpdir(), "lupa-eval-import-"));
    roots.push(root);
    const eventPath = join(root, "event.json");
    const outputPath = join(root, "output.txt");
    writeFileSync(eventPath, JSON.stringify({ ref: "refs/heads/synthetic", after: "a".repeat(40) }));
    const probeUrl = new URL("./import-bundle-probe.mjs", import.meta.url);
    execFileSync(process.execPath, [probeUrl.pathname, new URL("../../dist/index.js", import.meta.url).href], {
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: "push",
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_OUTPUT: outputPath,
      },
      stdio: "pipe",
    });
    expect(existsSync(outputPath)).toBe(false);
  });
});
