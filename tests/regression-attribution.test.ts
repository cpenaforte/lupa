import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { parseDiffFiles } from "../src/diff/patch.js";
import { parseHunks } from "../src/diff.js";
import { evaluateRawGate, eventFor, exitFor, projectRenderMarks, validateChangeAnchor } from "../src/review/policy.js";
import { groupFindings } from "../src/review/grouping.js";
import { assessmentExit, assessAnalysis } from "../src/domain/assessment.js";
import type { Finding } from "../src/domain/finding.js";
import { sanitizeFinding, stripProvenance } from "../src/domain/finding.js";
import { toFindings } from "../src/llm/schema.js";
import { redactFindings } from "../src/review.js";
import { readFindings, writeFindings } from "../src/artifacts/review-store.js";

const patch = readFileSync(new URL("./fixtures/evals/deleted-authorization.patch", import.meta.url), "utf8");
const files = parseDiffFiles(patch);
const hunks = parseHunks(files);
const finding: Finding = { severity: "high", file: "src/auth.ts", line: 3, rule: "missing-auth", message: "The removed guard permits unauthorized deletion." };
const anchor = { file: "src/auth.ts", line: 2, side: "LEFT" as const };
function gate(f: Finding, policy: "required" | "advisory" = "required") {
  return evaluateRawGate([f], hunks, files, [], undefined, { analysisPolicy: policy });
}
function result(f: Finding) {
  const decision = gate(f);
  const status = assessAnalysis({ triggered: true, scope: "semantic", stages: [], coverage: { filesTotal: 1, hunksTotal: 1, filesReviewed: 1, hunksReviewed: 1, issues: decision.attributionIssues ?? [], issuesOmitted: 0 } });
  return { event: eventFor("high", decision.blocking), exit: assessmentExit("required", status, exitFor("high", decision.blocking)), status };
}
describe("causal attribution independent of display location", () => {
  it("cannot raise a grouped baseline high to blocking through a causal warning member", () => {
    const findings: Finding[] = [
      { ...finding, file: "untouched.ts", rule: "baseline" },
      { ...finding, file: "untouched.ts", severity: "warning", rule: "causal", change: anchor },
    ];
    const decision = evaluateRawGate(findings, hunks, files, [], undefined, { analysisPolicy: "required" });
    const { groups } = groupFindings(findings, { pairs: [[0, 1]], links: [], malformed: 0 });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.finding.severity).toBe("high");
    expect(projectRenderMarks(groups, findings, decision).blocking.size).toBe(1);
    expect(decision.blocking).toEqual([findings[1]]);
    expect(eventFor("high", decision.blocking)).toBe("COMMENT");
    expect(exitFor("high", decision.blocking)).toBe(0);
    expect(decision.attributionIssues).toEqual([]);
  });
  it("an invalid diagnostic cannot negate independent added-line eligibility", () => {
    const added = [{ file: finding.file, hunks: "@@ -1 +1,2 @@\n before();\n+added();\n", truncated: false }];
    const f = { ...finding, line: 2, changeInvalid: true as const };
    const decision = evaluateRawGate([f], parseHunks(added), added, [], undefined, { analysisPolicy: "required" });
    expect(decision.blocking).toEqual([f]);
    expect(decision.attributionIssues).toHaveLength(1);
  });
  it("does not guess through ambiguous or truncated patch paths", () => {
    expect(validateChangeAnchor(anchor, [files[0]!, { ...files[0]!, file: "renamed.ts", oldFile: anchor.file }], hunks).ok).toBe(false);
    expect(validateChangeAnchor(anchor, [{ ...files[0]!, truncated: true }], hunks).ok).toBe(false);
  });
  it.each([false, true])("rejects old-path anchors when another patch section shares the resolved destination (reversed=%s)", reversed => {
    const colliding = [
      { file: "new.ts", deleted: true, hunks: "@@ -2 +0,0 @@\n-unrelated();\n", truncated: false },
      { file: "new.ts", oldFile: "old.ts", hunks: "@@ -10 +10 @@\n-guard();\n+unsafe();\n", truncated: false },
    ];
    if (reversed) colliding.reverse();
    const parsed = parseHunks(colliding);
    const change = { file: "old.ts", line: 2, side: "LEFT" as const };
    expect(validateChangeAnchor(change, colliding, parsed).ok).toBe(false);
    const f = { ...finding, file: "untouched.ts", change };
    const decision = evaluateRawGate([f], parsed, colliding, [], undefined, { analysisPolicy: "required" });
    expect(decision.blocking).toEqual([]);
    expect(decision.attributionIssues).toContainEqual(expect.objectContaining({ code: "invalid-change-anchor" }));
    const status = assessAnalysis({ triggered: true, scope: "semantic", stages: [], coverage: { filesTotal: 2, hunksTotal: 2, filesReviewed: 2, hunksReviewed: 2, issues: decision.attributionIssues, issuesOmitted: 0 } });
    expect(status).toBe("incomplete");
    expect(eventFor("high", decision.blocking)).toBe("COMMENT");
    expect(assessmentExit("required", status, exitFor("high", decision.blocking))).toBe(3);
    const added = { ...f, file: "new.ts", line: 10 };
    const independent = evaluateRawGate([added], parsed, colliding, [], undefined, { analysisPolicy: "required" });
    expect(independent.blocking).toEqual([added]);
    expect(independent.attributionIssues).toHaveLength(1);
  });
  it("refuses a control-stripped path even if it would match an actual deletion", () => {
    const safe = sanitizeFinding({ ...finding, change: { ...anchor, file: "src/au\u0000th.ts" } });
    expect(safe.changeInvalid).toBe(true);
    expect(result(safe)).toEqual({ event: "COMMENT", exit: 3, status: "incomplete" });
  });
  it.each([null, undefined])("accepts a legacy/null anchor without manufacturing invalid attribution: %s", change => {
    const parsed = toFindings({ findings: [{ ...finding, file: "untouched.ts", suggestion: null, change }] })!;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).not.toHaveProperty("change");
    expect(parsed[0]).not.toHaveProperty("changeInvalid");
    expect(result(parsed[0]!).status).toBe("complete");
  });
  it("preserves a valid claim through agent, sanitization, redaction and artifact roundtrip", () => {
    const parsed = toFindings({ findings: [{ ...finding, suggestion: null, change: anchor }] })!;
    const safe = redactFindings(parsed.map(stripProvenance).map(sanitizeFinding), ["secret"]);
    const dir = mkdtempSync(join(tmpdir(), "anchor-"));
    try {
      writeFindings(dir, safe);
      expect(readFindings(dir)[0]?.change).toEqual(anchor);
      expect(result(readFindings(dir)[0]!).exit).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each([false, [], { ...anchor, side: "BAD" }, { ...anchor, line: 0 }, { ...anchor, line: 1.5 }, { ...anchor, file: "src/au\u0000th.ts" }, { ...anchor, file: "x".repeat(201) }, { ...anchor, file: "../auth.ts" }, { ...anchor, extra: true }])("keeps malformed/lossy claims distinct from missing legacy input: %j", change => {
    const model = toFindings({ findings: [{ ...finding, file: "untouched.ts", suggestion: null, change }] })!;
    expect(model).toHaveLength(1);
    const safe = sanitizeFinding(stripProvenance(model[0]!));
    expect(safe.changeInvalid).toBe(true);
    expect(safe).not.toHaveProperty("change");
    const dir = mkdtempSync(join(tmpdir(), "anchor-"));
    try {
      writeFindings(dir, [safe]);
      expect(result(readFindings(dir)[0]!).exit).toBe(3);
      writeFileSync(join(dir, "findings.json"), JSON.stringify([{ ...finding, file: "untouched.ts", change }]));
      expect(readFindings(dir)[0]?.changeInvalid).toBe(true);
      expect(result(readFindings(dir)[0]!).exit).toBe(3);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("redaction cannot turn a secret path into another patch identity", () => {
    const safe = redactFindings([{ ...finding, file: "untouched.ts", change: { ...anchor, file: "secret.ts" } }], ["secret"])[0]!;
    expect(JSON.stringify(safe)).not.toContain("secret");
    expect(safe.changeInvalid).toBe(true);
    expect(result(safe).exit).toBe(3);
    expect(gate(safe, "advisory").attributionIssues).toEqual([]);
  });
  it("gates a removed protection on LEFT while its display is unchanged context", () => {
    expect(result({ ...finding, change: anchor })).toEqual({ event: "REQUEST_CHANGES", exit: 1, status: "complete" });
    expect(gate({ ...finding, change: anchor }, "advisory").blocking).toEqual([]);
    expect(gate({ ...finding, change: anchor }, "advisory").attributionIssues).toEqual([]);
  });
  it("matches the explicit side even when RIGHT has the same numeric context line", () => {
    expect(validateChangeAnchor(anchor, files, hunks)).toEqual({ ok: true, anchor });
    expect(validateChangeAnchor({ ...anchor, side: "RIGHT" }, files, hunks).ok).toBe(false);
  });
  it("allows causal additions in a caller independently of a display in another file", () => {
    const caller = [{ file: "src/caller.ts", hunks: "@@ -1 +1,2 @@\n call();\n+unsafe();\n", truncated: false }];
    const f = { ...finding, change: { file: "src/caller.ts", line: 2, side: "RIGHT" as const } };
    expect(evaluateRawGate([f], parseHunks(caller), caller, [], undefined, { analysisPolicy: "required" }).blocking).toEqual([f]);
  });
  it("uses retained old path for a renamed LEFT deletion", () => {
    const renamed = [{ ...files[0]!, file: "src/new-auth.ts", oldFile: "src/auth.ts" }];
    expect(validateChangeAnchor(anchor, renamed, parseHunks(renamed)).ok).toBe(true);
    expect(validateChangeAnchor({ ...anchor, side: "RIGHT" }, renamed, parseHunks(renamed)).ok).toBe(false);
  });
  it("makes a touched high with a missing legacy anchor incomplete but preserves untouched advice", () => {
    expect(result(finding)).toEqual({ event: "COMMENT", exit: 3, status: "incomplete" });
    expect(result({ ...finding, file: "src/backlog.ts" })).toEqual({ event: "COMMENT", exit: 0, status: "complete" });
  });
  it.each([
    { ...anchor, line: 1 }, { ...anchor, line: 999 }, { ...anchor, file: "src/forged.ts" },
    { ...anchor, file: "/src/auth.ts" }, { ...anchor, file: "src/../src/auth.ts" },
  ])("retains invalid anchors as nonblocking advice with incomplete attribution: %j", change => {
    expect(result({ ...finding, file: "src/backlog.ts", change })).toEqual({ event: "COMMENT", exit: 3, status: "incomplete" });
  });
  it("preserves existing addition and reopened eligibility without an anchor", () => {
    const added = [{ file: finding.file, hunks: "@@ -1 +1,2 @@\n before();\n+added();\n", truncated: false }];
    const f = { ...finding, line: 2 };
    expect(evaluateRawGate([f], parseHunks(added), added, [], undefined, { analysisPolicy: "required" }).blocking).toEqual([f]);
    const reopened = evaluateRawGate([finding], hunks, files, [{ isResolved: true, authorLogin: "bot", path: finding.file, line: finding.line!, originalLine: null, rule: finding.rule }], "bot", { analysisPolicy: "required" });
    expect(reopened.blocking).toEqual([finding]);
    expect(reopened.attributionIssues).toEqual([]);
  });
  it("never matches a truncated or control-stripped path alias", () => {
    const longPath = "dir/".repeat(50) + "auth.ts"; // 207 code points
    const prefix = longPath.slice(0, 200);
    const truncated = sanitizeFinding({ ...finding, file: longPath, line: 2 });
    expect(truncated.file).toBe("");
    expect(truncated.line).toBeUndefined();
    expect(truncated.message).toMatch(/^artifact path rejected: /);
    const control = sanitizeFinding({ ...finding, file: "src/au\u0000th.ts", line: 2 });
    expect(control.file).toBe("");
    expect(control.line).toBeUndefined();
    const diff = [{ file: prefix, hunks: "@@ -1 +1,2 @@\n before();\n+added();\n", truncated: false }];
    expect(evaluateRawGate([truncated, control], parseHunks(diff), diff, [], undefined, { analysisPolicy: "required" }).blocking).toEqual([]);
  });
});
