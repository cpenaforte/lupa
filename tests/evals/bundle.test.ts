import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { evalCases } from "./corpus.js";
import { cleanupEvalRuns, runBundleEval } from "./harness.js";
import type { EvalCase, EvalRun } from "./types.js";
import { PER_FILE_CAP } from "../../src/diff.js";

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
      if (finding.line !== undefined && !testCase.categories.includes("deletion")) {
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

const requiredCategories = ["positive", "safe-negative", "repaired", "deletion", "force-push", "fork-readonly", "large-diff", "unchanged-baseline"] as const;

function promptDiff(result: EvalRun): string {
  return result.prompts.user.split("<untrusted-diff>\n")[1]?.split("\n</untrusted-diff>")[0] ?? "";
}

describe("synthetic bundle regression cases", () => {
  it("has unique case IDs and every required category", () => {
    const ids = evalCases.map(({ id }) => id);
    expect(new Set(ids).size, "duplicate case IDs in synthetic evaluation corpus").toBe(ids.length);
    const categories = new Set(evalCases.flatMap(({ categories }) => categories));
    const missing = requiredCategories.filter((category) => !categories.has(category));
    expect(missing, `missing required categories: ${missing.join(", ")}`).toEqual([]);
  });

  it.each(evalCases.map((testCase) => [testCase.id, testCase] as const))("%s", async (_id, testCase) => {
    const fetchMock = vi.fn(() => { throw new Error("unexpected network request in synthetic evaluation"); });
    vi.stubGlobal("fetch", fetchMock);
    const result = await runBundleEval(testCase);
    assertCommonCaseContract(testCase, result);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps a deleted-line finding to the exact LEFT-side comment", async () => {
    const testCase = evalCases.find(({ id }) => id === "synthetic-deletion-removed-unsafe-branch")!;
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("unexpected network request"); }));
    const result = await runBundleEval(testCase);
    assertCommonCaseContract(testCase, result);
    expect(result.publications[0]).toMatchObject({ path: "review", pr: 17, payload: { comments: [{
      path: "src/legacy.ts", line: 3, side: "LEFT",
      body: "**warning** [removed-unsafe-branch] The removed legacy branch bypassed validation.",
    }] } });
  });

  it("skips publication when the live PR head moves before the POST", async () => {
    const testCase = evalCases.find(({ id }) => id === "synthetic-force-push-head-moves-before-post")!;
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("unexpected network request"); }));
    const result = await runBundleEval(testCase);
    assertCommonCaseContract(testCase, result);
    expect(result.gatewayCalls.filter(({ method }) => method === "getPr")).toHaveLength(2);
    expect(result.gatewayCalls.filter(({ method }) => method === "createReview")).toHaveLength(0);
    expect(result.outcome.posted).toBe(false);
    expect(result.outcome.staleSkipped).toBeUndefined();
    expect(result.outcome.exitCode).toBe(2);
  });

  it("keeps read-only fork review runs summary-only", async () => {
    const testCase = evalCases.find(({ id }) => id === "synthetic-fork-readonly-summary-only")!;
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("unexpected network request"); }));
    const result = await runBundleEval(testCase);
    assertCommonCaseContract(testCase, result);
    expect(result.summary).toContain("lupa: 2 finding(s).");
    expect(result.outcome.posted).toBe(false);
    expect(result.gatewayCalls.filter(({ method }) => ["createReview", "createIssueComment"].includes(method))).toEqual([]);
  });

  it("caps one oversized per-file diff excerpt", async () => {
    const testCase = evalCases.find(({ id }) => id === "synthetic-large-diff-per-file-cap")!;
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("unexpected network request"); }));
    const result = await runBundleEval(testCase);
    assertCommonCaseContract(testCase, result);
    const excerpt = promptDiff(result);
    expect(excerpt).toContain("--- src/large.ts");
    expect(excerpt.length).toBeLessThanOrEqual(PER_FILE_CAP);
    expect(excerpt).toContain("[... truncated ...]");
  });

  it("omits over-budget files and names them in the budget note", async () => {
    const testCase = evalCases.find(({ id }) => id === "synthetic-large-diff-global-budget")!;
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("unexpected network request"); }));
    const result = await runBundleEval(testCase);
    assertCommonCaseContract(testCase, result);
    const excerpt = promptDiff(result);
    expect(excerpt).toContain("--- src/included.ts");
    expect(excerpt).not.toContain("--- src/omitted.ts");
    expect(excerpt.length).toBeGreaterThan(0);
    expect(excerpt.length).toBeLessThanOrEqual(testCase.inputOverrides!.maxDiffChars!);
    expect(result.prompts.user).toContain("## Diff budget note");
    expect(result.prompts.user).toContain("- src/omitted.ts");
  });

  it("keeps the unchanged baseline path out of the diff excerpt and comments", async () => {
    const testCase = evalCases.find(({ id }) => id === "synthetic-unchanged-baseline-not-in-diff")!;
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("unexpected network request"); }));
    const result = await runBundleEval(testCase);
    assertCommonCaseContract(testCase, result);
    expect(promptDiff(result)).toContain("--- src/safe.ts");
    expect(promptDiff(result)).not.toContain("src/legacy-vulnerability.ts");
    expect(result.publications.flatMap((publication) => publication.payload?.comments ?? []).some(({ path }) => path === "src/legacy-vulnerability.ts")).toBe(false);
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
