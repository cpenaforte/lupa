import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readAssessment, writeAssessment, writePrMeta } from "../src/artifacts/review-store.js";
import type { AnalysisAssessment } from "../src/domain/assessment.js";
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));
function setup() {
  const dir = mkdtempSync("/tmp/lupa-assessment-"); dirs.push(dir);
  writePrMeta({ pr_number: 7, head_sha: "a".repeat(40), base_sha: "b".repeat(40), head_repo_full_name: "o/r", is_fork: false }, dir);
  const assessment: AnalysisAssessment = { version: 1, baseSha: "b".repeat(40), headSha: "a".repeat(40), policy: "advisory", scope: "semantic", status: "complete", stages: [{ stage: "semantic", status: "ok", required: true, applicable: true }], coverage: { filesTotal: 1, hunksTotal: 1, filesReviewed: 1, hunksReviewed: 1, issues: [], issuesOmitted: 0 } };
  return { dir, assessment };
}
describe("assessment artifacts", () => {
  it("round-trips SHA-bound assessment metadata", () => {
    const { dir, assessment } = setup(); writeAssessment(dir, assessment, 10000, []);
    expect(readAssessment(dir, 10000)).toEqual(assessment);
  });
  it("rejects malformed, oversized and mismatched metadata as unavailable", () => {
    const { dir, assessment } = setup();
    for (const bad of [{ ...assessment, headSha: "c".repeat(40) }, { ...assessment, coverage: { ...assessment.coverage, filesReviewed: 2 } }, { ...assessment, stages: [{ stage: "x", status: "ok" }] }, { ...assessment, status: "approved" }]) {
      writeFileSync(join(dir, "analysis.json"), JSON.stringify(bad));
      expect(readAssessment(dir, 10000)).toBeUndefined();
    }
    writeFileSync(join(dir, "analysis.json"), "not json"); expect(readAssessment(dir, 10000)).toBeUndefined();
    writeAssessment(dir, assessment, 10000, []); expect(readAssessment(dir, 10)).toBeUndefined();
  });
  it("caps records, preserves omission counts, and masks runtime keys", () => {
    const { dir, assessment } = setup();
    assessment.coverage.issues = Array.from({ length: 205 }, () => ({ code: "x", message: "secret-key" }));
    assessment.coverage.issuesOmitted = 3;
    assessment.stages = Array.from({ length: 40 }, () => ({ stage: "check", status: "ok", applicable: true, required: true, reason: "secret-key" }));
    writeAssessment(dir, assessment, 100000, ["secret-key"]);
    const r = readAssessment(dir, 100000)!;
    expect(r.status).toBe("incomplete"); expect(r.stages).toHaveLength(32);
    expect(r.coverage.issues).toHaveLength(200); expect(r.coverage.issuesOmitted).toBeGreaterThanOrEqual(8);
    expect(JSON.stringify(r)).toContain("8 stage");
    expect(readFileSync(join(dir, "analysis.json"), "utf8")).not.toContain("secret-key");
  });
  it("writes a small incomplete overflow record", () => {
    const { dir, assessment } = setup(); assessment.stages[0]!.reason = "x".repeat(10000);
    writeAssessment(dir, assessment, 1000, []);
    const raw = readFileSync(join(dir, "analysis.json"), "utf8"); expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(1000);
    expect(readAssessment(dir, 1000)).toMatchObject({ status: "incomplete", coverage: { issues: [expect.objectContaining({ code: "assessment-overflow" })] } });
  });
});
