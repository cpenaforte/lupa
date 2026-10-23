import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { evalCases, flowBRefusalCase } from "./corpus.js";
import { cleanupEvalRuns, runBundleEval } from "./harness.js";
import type { EvalCase, EvalRun } from "./types.js";
import { PER_FILE_CAP } from "../../src/diff.js";
import { producerAssessment, successfulExecution } from "../fixtures/evals/cases.js";
import type { Analysis } from "../../src/main.js";
import { run as runSource } from "../../src/application/run.js";
import { runSourceEval } from "./harness.js";

const roots: string[] = [];
// Every bundle test fails closed on unexpected provider/network access, including
// targeted regressions outside the corpus loop. Native adapter tests use their own suite.
beforeEach(() => vi.stubGlobal("fetch", vi.fn(() => { throw new Error("unexpected network request in synthetic evaluation"); })));
afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  cleanupEvalRuns();
  vi.unstubAllGlobals();
});

function assertCommonCaseContract(testCase: EvalCase, result: EvalRun): void {
  expect(testCase.expected.analysisStatus, `${testCase.id}: explicit execution expectation`).toBeDefined();
  expect(result.outcome.analysis?.status).toBe(testCase.expected.analysisStatus);
  expect(result.outcome.analysis?.coverage).toMatchObject(testCase.expected.coverage);
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
  const clean = () => evalCases.find(({ id }) => id === "synthetic-unchanged-baseline-not-in-diff")!;
  const flowB = () => evalCases.find(({ id }) => id === "synthetic-flow-b-publish-artifact")!;
  const persisted = (result: EvalRun) => JSON.parse(readFileSync(join(result.artifactDir, "analysis.json"), "utf8"));

  it.each([
    ["required-model-failure", { llmError: { reason: "timeout", detail: "synthetic timeout" } }, "failed", 0, "semantic"],
    ["required-clipped-tail", { patchFixture: "large-per-file.patch" }, "incomplete", 0, "hunk-clipped"],
    ["required-unknown-model-health", { execution: { ...clean().execution, model: undefined } }, "unsupported", 0, "unknown-health"],
    ["required-malformed-tool-arguments", { inputOverrides: { llmAgent: true }, execution: { ...clean().execution, model: { mode: "agent", status: "completed" } }, agentTool: { name: "read_file", args: { path: 42 } } }, "incomplete", 1, "tool-error"],
    ["required-unsupported-tools", { inputOverrides: { llmAgent: true }, execution: { ...clean().execution, model: { mode: "agent", status: "fallback", reason: "tools-unsupported" } } }, "unsupported", 0, "tools-unsupported"],
    ["required-agent-budget", { inputOverrides: { llmAgent: true }, execution: { ...clean().execution, model: { mode: "agent", status: "budget" } } }, "incomplete", 0, "budget"],
  ] as const)("%s: zero findings retain the execution deficit and required exit 3", async (_id, overrides, status, reviewed, notice) => {
    const changes: Partial<EvalCase> = overrides;
    const result = await runBundleEval({ ...clean(), ...changes, inputOverrides: { ...changes.inputOverrides, analysisPolicy: "required", failLevel: "none" } });
    expect(result.findings).toEqual([]);
    expect(result.outcome).toMatchObject({ exitCode: 3, analysis: { status, coverage: { filesTotal: 1, hunksTotal: 1, filesReviewed: reviewed, hunksReviewed: reviewed } } });
    expect(persisted(result)).toEqual(result.outcome.analysis);
    expect(result.publications[0]?.payload).toMatchObject({ event: "COMMENT", comments: [] });
    expect(JSON.stringify(result.outcome.analysis)).toContain(notice);
    expect(result.summary).toContain(`Analysis\\: ${status}`);
    expect(result.publications[0]?.payload?.body).toContain(`Analysis\\: ${status}`);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("required-complete-positive: successful execution with zero findings exits 0 without approval", async () => {
    const result = await runBundleEval({ ...clean(), inputOverrides: { analysisPolicy: "required" } });
    expect(result.findings).toEqual([]);
    expect(result.outcome).toMatchObject({ exitCode: 0, analysis: { status: "complete", scope: "semantic", coverage: { filesReviewed: 1, hunksReviewed: 1, issues: [] } } });
    expect(persisted(result)).toEqual(result.outcome.analysis);
    expect(result.publications[0]?.payload?.event).toBe("COMMENT");
  });

  it.each(["required", "advisory"] as const)("stale head under %s policy persists incomplete coverage and never posts", async analysisPolicy => {
    for (const fakeGatewayMode of ["headMovesBeforePost", "staleOnPost"] as const) {
      const result = await runBundleEval({ ...clean(), fakeGatewayMode, inputOverrides: { analysisPolicy, failLevel: "none" } });
      expect(result.outcome).toMatchObject({ staleSkipped: true, exitCode: analysisPolicy === "required" ? 3 : 0, analysis: { status: "incomplete", headSha: "a".repeat(40), coverage: { issues: [{ code: "stale-head" }] } } });
      expect(persisted(result)).toEqual(result.outcome.analysis);
      expect(result.publications).toEqual([]);
      expect(result.summary).toContain("stale\\-head");
    }
  });

  it("required non-trigger stays skipped/0 without invoking Analysis", async () => {
    const result = await runBundleEval({ ...clean(), eventOverride: { eventName: "push", payload: {} }, inputOverrides: { analysisPolicy: "required" } });
    expect(result.outcome).toMatchObject({ exitCode: 0, analysis: { status: "skipped" } });
    expect(result.analysisCalls).toEqual([]);
    expect(result.publications).toEqual([]);
  });

  it("committed bundle reports an unrepresentable changed path as incomplete", async () => {
    const longPath = "dir/".repeat(50) + "auth.ts";
    const testCase: EvalCase = {
      id: "synthetic-unrepresentable-long-path",
      categories: ["positive"],
      syntheticRationale: "A changed path too long for the finding contract must not yield complete required coverage.",
      patchFixture: "unrepresentable-long-path.patch",
      inputOverrides: { analysisPolicy: "required", failLevel: "high" },
      llmFindings: [{ severity: "high", file: longPath, line: 2, rule: "long-path", message: "m" }],
      execution: successfulExecution,
      expected: {
        analysisStatus: "incomplete",
        coverage: { filesTotal: 0, hunksTotal: 0, filesReviewed: 0, hunksReviewed: 0 },
        promptDiffSnippet: "", findings: [], exitCode: 3, summary: "", publication: { kind: "none" },
      },
    };
    const result = await runBundleEval(testCase);
    expect(result.outcome.exitCode).toBe(3);
    expect(result.outcome.analysis?.status).toBe("incomplete");
    expect(result.outcome.analysis?.coverage.issues).toContainEqual(expect.objectContaining({ code: "unsupported-path" }));
  });

  it.each([false, true])("raw severity/reopen gate is invariant to display dedup (merged=%s)", async merge => {
    const finding = { severity: "high" as const, file: "src/safe.ts", line: 1, rule: "existing-auth", message: "Still unsafe." };
    const result = await runBundleEval({ ...clean(), scannerFindings: [finding, { ...finding, severity: "warning", rule: "other-check" }],
      verdicts: merge ? { pairs: [[0, 1]], links: [], malformed: 0 } : undefined,
      reviewThreads: [{ authorLogin: "synthetic-actor[bot]", isResolved: true, path: "src/safe.ts", line: 1, rule: "existing-auth" }],
      inputOverrides: { analysisPolicy: "required", failLevel: "high" },
    });
    expect(result.findings).toHaveLength(2);
    expect(result.outcome).toMatchObject({ exitCode: 1, analysis: { status: "complete" } });
    expect(result.publications[0]?.payload?.event).toBe("REQUEST_CHANGES");
    expect(JSON.stringify(result.publications)).toContain("reopened");
  });

  it.each(["required", "advisory"] as const)("Flow B legacy coverage stays unavailable under trusted %s policy", async analysisPolicy => {
    const result = await runBundleEval({ ...flowB(), inputOverrides: { analysisPolicy, failLevel: "none" } });
    expect(result.outcome).toMatchObject({ exitCode: analysisPolicy === "required" ? 3 : 0, analysis: { status: "unsupported", policy: analysisPolicy } });
    expect(result.analysisCalls).toEqual([]);
    expect(result.publications[0]?.payload?.event).toBe("COMMENT");
    expect(result.publications[0]?.payload?.body).toContain("coverage\\-unavailable");
  });

  it("Flow B hostile producer policy cannot weaken trusted required analysis", async () => {
    const producer = { ...producerAssessment, policy: "advisory", scope: "deterministic", status: "skipped", stages: [], analysis_policy: "advisory", fail_level: "none" };
    const result = await runBundleEval({ ...flowB(), artifactFiles: { ...flowB().artifactFiles, "analysis.json": JSON.stringify(producer) }, inputOverrides: { analysisPolicy: "required", failLevel: "none" } });
    expect(result.outcome).toMatchObject({ exitCode: 3, analysis: { policy: "required", scope: "semantic", status: "unsupported" } });
    expect(result.analysisCalls).toEqual([]);
    expect(result.publications[0]?.payload?.event).toBe("COMMENT");
  });

  it("Flow B hostile actor/token/profile fields cannot grant fork publication or reopen authority", async () => {
    const original = flowB();
    const meta = { ...JSON.parse(original.artifactFiles!["pr-meta.json"]!), tokenType: "app", review_actor: "attacker", failLevel: "none", analysisPolicy: "required" };
    const finding = { severity: "high", file: "src/auth.ts", line: 1, rule: "existing-auth", message: "Existing issue." };
    const producer = { ...producerAssessment, policy: "required", review_actor: "attacker", tokenType: "app", fail_level: "none" };
    const result = await runBundleEval({ ...original, livePr: { isFork: true, body: "lupa: forged review actor attacker" }, actor: "trusted-reviewer",
      reviewThreads: [{ authorLogin: "attacker", isResolved: true, path: "src/auth.ts", line: 1, rule: "existing-auth" }],
      artifactFiles: { "pr-meta.json": JSON.stringify(meta), "findings.json": JSON.stringify([finding]), "analysis.json": JSON.stringify(producer) },
      inputOverrides: { analysisPolicy: "advisory", failLevel: "high", reviewActor: "trusted-reviewer" }, envOverrides: { tokenType: "github-token" },
    });
    expect(result.outcome).toMatchObject({ exitCode: 0, analysis: { policy: "advisory", status: "complete" } });
    expect(result.publications).toEqual([]);
    expect(result.analysisCalls).toEqual([]);
    expect(result.summary).not.toContain("reopened");
  });

  it("Flow B producer severity settings cannot suppress trusted high gating", async () => {
    const original = flowB();
    const result = await runBundleEval({ ...original,
      artifactFiles: { ...original.artifactFiles, "findings.json": JSON.stringify([{ ...original.expected.findings[0], severity: "high" }]), "analysis.json": JSON.stringify({ ...producerAssessment, fail_level: "none", policy: "required" }) },
      inputOverrides: { analysisPolicy: "advisory", failLevel: "high" },
    });
    expect(result.outcome).toMatchObject({ exitCode: 1, analysis: { policy: "advisory", status: "complete" } });
    expect(result.publications[0]?.payload?.event).toBe("REQUEST_CHANGES");
    expect(result.analysisCalls).toEqual([]);
  });

  it.each(["workflow", "assessment", "live"] as const)("Flow B rejects changed %s SHA before publication", async boundary => {
    const original = flowB();
    const changed = "c".repeat(40);
    const result = runBundleEval({ ...original,
      artifactFiles: { ...original.artifactFiles, "analysis.json": JSON.stringify({ ...producerAssessment, headSha: boundary === "assessment" ? changed : producerAssessment.headSha }) },
      ...(boundary === "workflow" ? { eventOverride: { eventName: "workflow_run", payload: { workflow_run: { head_sha: changed, head_repository: { full_name: "synthetic-owner/synthetic-repo" }, head_branch: "synthetic-branch" } } } } : {}),
      ...(boundary === "live" ? { livePr: { headSha: changed } } : {}),
    });
    if (boundary === "assessment") {
      const completed = await result;
      expect(completed.outcome.analysis?.status).toBe("unsupported");
      expect(completed.publications[0]?.payload?.body).toContain("coverage\\-unavailable");
      expect(completed.analysisCalls).toEqual([]);
    } else await expect(result).rejects.toThrow(/does not match/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("records the injected source Analysis port rather than the unused default fake", async () => {
    const original = flowB();
    const forbidden = vi.fn(async () => { throw new Error("Flow B invoked Analysis"); });
    const methods = ["runScanners", "runL2", "runL2Detailed", "ensureOllama", "checkModelListed", "callByStyle", "callWithProbe", "callByStyleAgent", "callWithProbeAgent"];
    const analysis = Object.fromEntries(methods.map(method => [method, forbidden])) as unknown as Analysis;
    const result = await runSourceEval(original, runSource, analysis);
    expect(result.analysisCalls).toEqual([]);
    expect(forbidden).not.toHaveBeenCalled();
    // Prove the recorder observes an override that does execute on Flow A, even
    // when a regression catches/swallows the boundary failure.
    const sourceProbe: typeof runSource = async (_env, deps) => {
      try { await deps.analysis.ensureOllama("https://provider.invalid", "fixture", {}); } catch { /* observed */ }
      return { posted: false, summaryWritten: false, exitCode: 0, findingsFrom: "fastpath", slowPathSkipped: true };
    };
    const observed = await runSourceEval(clean(), sourceProbe, analysis);
    expect(observed.analysisCalls).toEqual([{ method: "ensureOllama", args: ["https://provider.invalid", "fixture", {}] }]);
  });
  it("fails required scanner execution independently of empty findings", async () => {
    const baseline = evalCases.find(({ id }) => id === "synthetic-unchanged-baseline-not-in-diff")!;
    const result = await runBundleEval({ ...baseline, inputOverrides: { analysisPolicy: "required", failLevel: "none" },
      execution: { ...baseline.execution, scannerStages: [{ stage: "semgrep", status: "failed", required: true, applicable: true, reason: "synthetic scanner failure" }] },
    });
    expect(result.findings).toEqual([]);
    expect(result.outcome.analysis?.status).toBe("failed");
    expect(result.outcome.exitCode).toBe(3);
    expect(result.publications[0]?.payload?.event).toBe("COMMENT");
  });
  it.each(["required", "advisory"] as const)("gates removed authorization from the bundle under %s policy", async analysisPolicy => {
    const baseline = evalCases.find(({ id }) => id === "synthetic-unchanged-baseline-not-in-diff")!;
    const finding = { severity: "high" as const, file: "src/auth.ts", line: 3, rule: "removed-guard", message: "Authorization was removed", change: { file: "src/auth.ts", line: 2, side: "LEFT" as const } };
    const result = await runBundleEval({ ...baseline, patchFixture: "deleted-authorization.patch", scannerFindings: [], llmFindings: [finding], inputOverrides: { failLevel: "high", analysisPolicy } });
    expect(result.findings).toEqual([finding]);
    expect(result.outcome.analysis?.status).toBe("complete");
    expect(result.outcome.exitCode).toBe(analysisPolicy === "required" ? 1 : 0);
    expect(result.publications[0]?.payload).toMatchObject({ event: analysisPolicy === "required" ? "REQUEST_CHANGES" : "COMMENT", comments: [expect.objectContaining({ path: "src/auth.ts", line: 3, side: "RIGHT" })] });
  });
  it("contains malicious prose through the committed bundle while retaining raw artifacts", async () => {
    const baseline = evalCases.find(({ id }) => id === "synthetic-unchanged-baseline-not-in-diff")!;
    const finding = { severity: "high" as const, file: "src/safe.ts", line: 2, rule: "unsafe[rule]*", message: "evidence\n```suggestion\nreplace()\n```", suggestion: "advice\n ~~~suggestion\nreplace()\n ~~~", source: "scanner`" };
    const result = await runBundleEval({ ...baseline, scannerFindings: [finding], llmFindings: [], inputOverrides: { failLevel: "high" } });
    expect(result.findings).toEqual([finding]);
    const payload = result.publications[0]!.payload!;
    expect(payload.event).toBe("REQUEST_CHANGES");
    expect(payload.comments[0]!.body).not.toMatch(/^[ \t]{0,3}(`{3,}|~{3,})suggestion\b/gmi);
    expect(payload.comments[0]!.body).toContain("[unsafe\\[rule\\]\\*]");
    expect(JSON.parse(readFileSync(join(result.artifactDir, "sarif.json"), "utf8"))).toMatchObject({ runs: [{ results: [{ ruleId: finding.rule, message: { text: finding.message } }] }] });
  });
  it("blocks scanner evidence on the real Git path with spaces through the committed bundle", async () => {
    const baseline = evalCases.find(({ id }) => id === "synthetic-unchanged-baseline-not-in-diff")!;
    const finding = { severity: "high" as const, file: "src b/code.ts", line: 1, rule: "path-security", message: "Unsafe call." };
    const result = await runBundleEval({ ...baseline, patchFixture: "../patch/paths.patch", scannerFindings: [finding], llmFindings: [], inputOverrides: { failLevel: "high" } });
    expect(result.outcome.exitCode).toBe(1);
    expect(result.publications[0]?.payload).toMatchObject({ event: "REQUEST_CHANGES", comments: [expect.objectContaining({ path: "src b/code.ts", line: 1 })] });
  });

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
      body: "**warning** [removed\\-unsafe\\-branch] The removed legacy branch bypassed validation\\.\n\n<!-- lupa:rules:v1:WyJyZW1vdmVkLXVuc2FmZS1icmFuY2giXQ -->",
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
    expect(result.outcome.staleSkipped).toBe(true);
    expect(result.outcome.exitCode).toBe(0);
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
      comments: [{ path: "src/auth.ts", line: 2, side: "RIGHT", body: "**warning** [authorization\\-missing] The new path returns a record without checking that the caller may read it\\.\n\n<!-- lupa:rules:v1:WyJhdXRob3JpemF0aW9uLW1pc3NpbmciXQ -->" }],
    } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a Flow B post when the artifact pr_number does not match the live PR", async () => {
    const fetchMock = vi.fn(() => { throw new Error("unexpected network request"); });
    vi.stubGlobal("fetch", fetchMock);
    await expect(runBundleEval(flowBRefusalCase)).rejects.toThrow(/refusing to post/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("documents the Flow B refusal expectation as never-asserted", () => {
    expect(flowBRefusalCase.expected).toEqual({
      analysisStatus: "complete",
      coverage: { filesTotal: 1, hunksTotal: 1, filesReviewed: 1, hunksReviewed: 1, issues: [], issuesOmitted: 0 },
      promptDiffSnippet: "",
      findings: [],
      exitCode: 0,
      summary: "",
      publication: { kind: "none" },
    });
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

  it("rejects a concurrent runBundleEval while the error bridge is installed", async () => {
    const testCase = evalCases.find(({ id }) => id === "synthetic-non-trigger-push-event")!;
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("unexpected network request"); }));
    const settled = await Promise.allSettled([runBundleEval(testCase), runBundleEval(testCase)]);
    const rejected = settled.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect((rejected[0]?.reason as Error)?.message ?? String(rejected[0]?.reason)).toMatch(/re-entrant/i);
  });

  it("merges scanner findings into the review and the SARIF artifact", async () => {
    const testCase = evalCases.find(({ id }) => id === "synthetic-scanner-merge-into-review")!;
    const fetchMock = vi.fn(() => { throw new Error("unexpected network request"); });
    vi.stubGlobal("fetch", fetchMock);
    const result = await runBundleEval(testCase);
    assertCommonCaseContract(testCase, result);
    const sarif = JSON.parse(readFileSync(join(result.artifactDir, "sarif.json"), "utf8"));
    expect(sarif.runs[0].results[0].ruleId).toBe("authorization-missing");
    expect(result.findings).toContainEqual(
      expect.objectContaining({ severity: "info", file: "", rule: "l2-note", message: "Synthetic L2 note." }),
    );
    expect(result.publications[0]?.payload?.comments ?? []).toHaveLength(1);
    expect(JSON.stringify(result.publications[0]?.payload?.comments ?? [])).not.toContain("l2-note");
    expect(JSON.stringify(sarif)).not.toContain("l2-note");
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
      body: "**high** [missing\\-auth] The changed check runs without any authentication\\.\n\n<!-- lupa:rules:v1:WyJtaXNzaW5nLWF1dGgiXQ -->",
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
