import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authzFinding, evalCases, flowBRefusalCase, highFinding } from "./corpus.js";
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

const requiredCategories = [
  "positive",
  "safe-negative",
  "repaired",
  "deletion",
  "force-push",
  "fork-readonly",
  "large-diff",
  "unchanged-baseline",
  "flow-b",
  "dry-run",
  "non-trigger",
  "issue-fallback",
  "scanner-merge",
  "high-gate",
  "llm-failure",
  "stale-post",
] as const;

function promptDiff(result: EvalRun): string {
  return result.prompts.user.split("<untrusted-diff>\n")[1]?.split("\n</untrusted-diff>")[0] ?? "";
}

describe("synthetic bundle regression cases", () => {
  it("has unique case IDs and every required category", () => {
    const ids = evalCases.map(({ id }) => id);
    const seen = new Set<string>();
    const duplicateIds = ids.filter((id) => {
      if (seen.has(id)) return true;
      seen.add(id);
      return false;
    });
    const categories = new Set(evalCases.flatMap(({ categories }) => categories));
    const missingCategories = requiredCategories.filter((category) => !categories.has(category));
    const diagnostics = `duplicate case IDs: ${duplicateIds.join(", ") || "none"}; missing required categories: ${missingCategories.join(", ") || "none"}`;
    expect({ duplicateIds, missingCategories }, diagnostics).toEqual({ duplicateIds: [], missingCategories: [] });
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

  it("publishes the Flow B review from the staged artifact without analysis", async () => {
    const testCase = evalCases.find(({ id }) => id === "synthetic-flow-b-publish-artifact")!;
    const fetchMock = vi.fn(() => { throw new Error("unexpected network request"); });
    vi.stubGlobal("fetch", fetchMock);
    const result = await runBundleEval(testCase);
    assertCommonCaseContract(testCase, result);
    expect(result.analysisCalls).toEqual([]);
    expect(result.gatewayCalls.filter(({ method }) => method === "findPrsByHead")).toHaveLength(1);
    expect(result.publications[0]).toMatchObject({ path: "review", pr: 17, payload: {
      commit_id: "a".repeat(40),
      comments: [{ path: "src/auth.ts", line: 2, side: "RIGHT", body: "**warning** [authorization-missing] " + authzFinding.message }],
    } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a Flow B post when the artifact pr_number does not match the live PR", async () => {
    const fetchMock = vi.fn(() => { throw new Error("unexpected network request"); });
    vi.stubGlobal("fetch", fetchMock);
    await expect(runBundleEval(flowBRefusalCase)).rejects.toThrow(/refusing to post/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps a post_comment:false run summary-only", async () => {
    const testCase = evalCases.find(({ id }) => id === "synthetic-dry-run-post-comment-off")!;
    const fetchMock = vi.fn(() => { throw new Error("unexpected network request"); });
    vi.stubGlobal("fetch", fetchMock);
    const result = await runBundleEval(testCase);
    assertCommonCaseContract(testCase, result);
    expect(result.publications).toEqual([]);
    expect(result.outcome.posted).toBeFalsy();
    expect(result.outcome.exitCode).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("notes a non-triggering push event without analysis or writes", async () => {
    const testCase = evalCases.find(({ id }) => id === "synthetic-non-trigger-push-event")!;
    const fetchMock = vi.fn(() => { throw new Error("unexpected network request"); });
    vi.stubGlobal("fetch", fetchMock);
    const result = await runBundleEval(testCase);
    assertCommonCaseContract(testCase, result);
    expect(result.summary).toContain("does not trigger a review");
    expect(result.publications).toEqual([]);
    expect(result.analysisCalls).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to an issue comment when the review post is refused", async () => {
    const testCase = evalCases.find(({ id }) => id === "synthetic-issue-fallback-after-refusal")!;
    const fetchMock = vi.fn(() => { throw new Error("unexpected network request"); });
    vi.stubGlobal("fetch", fetchMock);
    const result = await runBundleEval(testCase);
    assertCommonCaseContract(testCase, result);
    expect(result.outcome.posted).toBe(true);
    expect(result.outcome.exitCode).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("merges scanner findings into the review and the SARIF artifact", async () => {
    const testCase = evalCases.find(({ id }) => id === "synthetic-scanner-merge-into-review")!;
    const fetchMock = vi.fn(() => { throw new Error("unexpected network request"); });
    vi.stubGlobal("fetch", fetchMock);
    const result = await runBundleEval(testCase);
    assertCommonCaseContract(testCase, result);
    const sarif = JSON.parse(readFileSync(join(result.artifactDir, "sarif.json"), "utf8"));
    expect(sarif.runs[0].results[0].ruleId).toBe("authorization-missing");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("gates a high-severity finding behind REQUEST_CHANGES", async () => {
    const testCase = evalCases.find(({ id }) => id === "synthetic-high-gate-request-changes")!;
    const fetchMock = vi.fn(() => { throw new Error("unexpected network request"); });
    vi.stubGlobal("fetch", fetchMock);
    const result = await runBundleEval(testCase);
    assertCommonCaseContract(testCase, result);
    expect(result.publications[0]?.payload?.event).toBe("REQUEST_CHANGES");
    expect(result.publications[0]?.payload?.comments).toContainEqual({
      path: "src/auth.ts",
      line: 2,
      side: "RIGHT",
      body: "**high** [missing-auth] " + highFinding.message,
    });
    expect(result.outcome.exitCode).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the fast-only clean review when the LLM call fails", async () => {
    const testCase = evalCases.find(({ id }) => id === "synthetic-llm-failure-fast-only")!;
    const fetchMock = vi.fn(() => { throw new Error("unexpected network request"); });
    vi.stubGlobal("fetch", fetchMock);
    const result = await runBundleEval(testCase);
    assertCommonCaseContract(testCase, result);
    expect(result.outcome.slowPathSkipped).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("exits cleanly when GitHub rejects the post as stale", async () => {
    const testCase = evalCases.find(({ id }) => id === "synthetic-stale-on-post-skip")!;
    const fetchMock = vi.fn(() => { throw new Error("unexpected network request"); });
    vi.stubGlobal("fetch", fetchMock);
    const result = await runBundleEval(testCase);
    assertCommonCaseContract(testCase, result);
    expect(result.outcome.staleSkipped).toBe(true);
    expect(result.outcome.exitCode).toBe(0);
    expect(result.publications).toEqual([]);
    expect(result.summary).toContain("skipping review for the stale head");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("imports the bundle for a push event without launching main", () => {
    const root = mkdtempSync(join(tmpdir(), "lupa-eval-import-"));
    roots.push(root);
    const eventPath = join(root, "event.json");
    const outputPath = join(root, "output.txt");
    writeFileSync(eventPath, JSON.stringify({ ref: "refs/heads/synthetic", after: "a".repeat(40) }));
    const probeUrl = new URL("./import-bundle-probe.mjs", import.meta.url);
    execFileSync(process.execPath, [fileURLToPath(probeUrl), new URL("../../dist/index.js", import.meta.url).href], {
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
