import { describe, expect, it } from "vitest";
import { assessAnalysis, assessmentExit, type AnalysisAssessment, type StageResult } from "../src/domain/assessment.js";
import { eventFor, exitFor } from "../src/review/policy.js";

const coverage: AnalysisAssessment["coverage"] = {
  filesTotal: 2, hunksTotal: 3, filesReviewed: 2, hunksReviewed: 3, issues: [], issuesOmitted: 0,
};
const scanner: StageResult = { stage: "semgrep", status: "ok", applicable: true, required: true };
const semantic: StageResult = { stage: "semantic", status: "ok", applicable: true, required: true };

function assess(stages: StageResult[], overrides: Partial<Parameters<typeof assessAnalysis>[0]> = {}) {
  return assessAnalysis({ triggered: true, scope: "semantic", stages, coverage, ...overrides });
}

describe("assessAnalysis", () => {
  it("completes successful required analysis with every eligible semantic unit accounted for", () => {
    expect(assess([scanner, semantic])).toBe("complete");
  });

  it.each(["model timeout", "invalid final response", "native invocation failure"])("fails required %s", (reason) => {
    expect(assess([{ ...scanner, status: "failed", reason }, semantic])).toBe("failed");
  });

  it.each(["missing-model", "missing-key", "missing-binary", "unknown-health", "unsupported-path", "agent-without-tools"])("reports required %s as unsupported", (reason) => {
    expect(assess([scanner, { ...semantic, status: "unsupported", reason }])).toBe("unsupported");
  });

  it("marks an applicable required skipped stage incomplete", () => {
    expect(assess([scanner, { ...semantic, status: "skipped", reason: "budget-exhausted" }])).toBe("incomplete");
  });

  it.each([
    { ...coverage, filesReviewed: 1 },
    { ...coverage, hunksReviewed: 2 },
    { ...coverage, issues: [{ code: "omitted-hunk", file: "a.ts", message: "A changed hunk was omitted" }] },
    { ...coverage, issuesOmitted: 1 },
  ])("marks missing semantic accounting incomplete: %j", (partial) => {
    expect(assess([scanner, semantic], { coverage: partial })).toBe("incomplete");
  });

  it("completes keyless deterministic scope without claiming semantic units were reviewed", () => {
    const unreviewed = { ...coverage, filesReviewed: 0, hunksReviewed: 0 };
    expect(assess([scanner, { ...semantic, status: "skipped", required: false, reason: "missing-model" }], {
      scope: "deterministic", coverage: unreviewed,
    })).toBe("complete");
    expect(unreviewed.filesReviewed).toBe(0);
    expect(unreviewed.hunksReviewed).toBe(0);
  });

  it("ignores optional SBOM failure and inapplicable required stages without hiding their evidence", () => {
    const stages: StageResult[] = [scanner, semantic,
      { stage: "sbom", status: "failed", applicable: true, required: false, reason: "unavailable" },
      { stage: "osv", status: "unsupported", applicable: false, required: true },
    ];
    expect(assess(stages)).toBe("complete");
    expect(stages[2]).toMatchObject({ status: "failed", reason: "unavailable" });
  });

  it("prioritizes required failure above unsupported and missing coverage regardless of order", () => {
    const stages: StageResult[] = [
      { ...scanner, status: "failed" }, { ...semantic, status: "unsupported" },
      { stage: "context", status: "skipped", applicable: true, required: true },
    ];
    expect(assess(stages, { coverage: { ...coverage, hunksReviewed: 0 } })).toBe("failed");
    expect(assess(stages.toReversed())).toBe("failed");
    expect(assess(stages.slice(1))).toBe("unsupported");
  });

  it("skips non-trigger events even when supplied evidence failed", () => {
    expect(assess([{ ...scanner, status: "failed" }], { triggered: false })).toBe("skipped");
  });

  it("classifies unsupported evidence through explicit stages, not descriptive issue codes", () => {
    const filtered = { ...coverage, issues: [{ code: "unsupported-path", file: "asset.map", message: "No applicable analyzer" }] };
    expect(assess([scanner, semantic], { coverage: filtered })).toBe("incomplete");
    expect(assess([scanner, semantic, {
      stage: "filtered-path", status: "unsupported", applicable: true, required: true, reason: "unsupported-path",
    }], { coverage: filtered })).toBe("unsupported");
  });

  it("does not mutate its stage or coverage inputs", () => {
    const input = { triggered: true, scope: "semantic" as const, stages: [scanner, semantic], coverage };
    const before = structuredClone(input);
    assessAnalysis(input);
    expect(input).toEqual(before);
  });
});

describe("assessmentExit", () => {
  it.each([
    ["required", "incomplete", 0, 3], ["required", "unsupported", 2, 3],
    ["required", "failed", 1, 3], ["required", "complete", 1, 1],
    ["advisory", "failed", 2, 2], ["required", "skipped", 0, 0],
    ["advisory", "skipped", 2, 0], [undefined, "failed", 2, 2],
  ] as const)("policy %s with %s and severity exit %i yields %i", (policy, status, severityExit, expected) => {
    expect(assessmentExit(policy, status, severityExit)).toBe(expected);
  });

  it("requires completeness independently of fail_level none without manufacturing a blocking review", () => {
    expect(eventFor("none", [])).toBe("COMMENT");
    expect(assessmentExit("required", "incomplete", exitFor("none", []))).toBe(3);
    expect(eventFor("high", [])).toBe("COMMENT");
  });
});
