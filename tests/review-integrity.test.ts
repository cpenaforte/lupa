import { describe, expect, it } from "vitest";
import type { Finding } from "../src/domain/finding.js";
import type { ReviewThread } from "../src/github.js";
import { parseHunks } from "../src/diff/patch.js";
import { evaluateRawGate, exitFor, groupFindings, mergeDuplicates, projectRenderMarks, reopenedKey } from "../src/review.js";
import { memberRuleMarker, memberRulesOf } from "../src/review/thread-identity.js";

const files = [{ file: "a.ts", hunks: "@@ -1,2 +1,2 @@\n unchanged\n-old\n+new", truncated: false }];
const hunks = parseHunks(files);
const longRule = "r".repeat(99);
const high: Finding = { severity: "high", file: "a.ts", line: 1, rule: "github-pat", message: "secret" };
const thread: ReviewThread = { authorLogin: "LUPA-BOT[bot]", isResolved: true, path: "a.ts", line: 1, rule: "github-pat" };

describe("raw review gate identity", () => {
  it.each([false, true])("keeps a resolved high blocking regardless of duplicate order (reverse=%s)", (reverse) => {
    const first: Finding = { ...high, rule: longRule };
    const findings = reverse ? [high, first] : [first, high];
    const decision = evaluateRawGate(findings, hunks, files, [thread], "lupa-bot");
    expect(decision.blocking).toEqual([high]);
    expect(exitFor("high", decision.blocking)).toBe(1);
    for (const pairs of [[], [[0, 1]]] as Array<Array<[number, number]>>) {
      const { groups } = groupFindings(findings, { pairs, links: [], malformed: 0 });
      const marks = projectRenderMarks(groups, findings, decision);
      const survivor = groups.find((g) => g.members.includes(findings.indexOf(high)))!;
      expect(marks.blocking.has(reopenedKey(survivor.finding))).toBe(true);
      expect(marks.reopened.has(reopenedKey(survivor.finding))).toBe(true);
    }
  });

  it.each([false, true])("does not promote an unrelated high from a reopened low member (reverse=%s)", (reverse) => {
    const low: Finding = { ...high, severity: "info" };
    const other: Finding = { ...high, rule: longRule };
    const findings = reverse ? [low, other] : [other, low];
    const decision = evaluateRawGate(findings, hunks, files, [thread], "lupa-bot[bot]");
    expect(decision.blocking).toEqual([low]);
    expect(exitFor("high", decision.blocking)).toBe(0);
    const { groups } = groupFindings(findings, { pairs: [[0, 1]], links: [], malformed: 0 });
    expect(projectRenderMarks(groups, findings, decision).reopened.has(reopenedKey(groups[0]!.finding))).toBe(true);
  });

  it("rejects cross-file and cross-line grouping without losing member indices", () => {
    const findings = [high, { ...high, file: "b.ts" }, { ...high, line: 2 }];
    const verdicts = { pairs: [[0, 1], [0, 2]] as Array<[number, number]>, links: [], malformed: 0 };
    const grouped = groupFindings(findings, verdicts);
    expect(grouped).toEqual({ groups: findings.map((finding, i) => ({ finding, members: [i] })), dropped: 2 });
    expect(mergeDuplicates(findings, verdicts)).toEqual({ merged: findings, dropped: 2 });
  });
});

describe("durable member metadata", () => {
  it("uses only the renderer's terminal marker, even when prose resembles metadata", () => {
    const fake = memberRuleMarker(["attacker"]);
    const real = memberRuleMarker([longRule, "github-pat"]);
    expect(memberRulesOf(`**high** [shown] ${fake}\n${fake}\n\n${real}`)).toEqual([longRule, "github-pat"]);
    expect(memberRulesOf(`**high** [shown] ${real}\n\ntrailer`)).toBeUndefined();
  });

  it("preserves empty rules allowed by the canonical finding contract", () => {
    expect(memberRulesOf(`**high** [display] text\n\n${memberRuleMarker(["", "github-pat"])}`)).toEqual(["", "github-pat"]);
  });

  it.each(["not-json", "{}", "[]", '["good",1]', "null"])("ignores invalid decoded shape %s", (decoded) => {
    const encoded = Buffer.from(decoded).toString("base64url");
    expect(memberRulesOf(`**high** [legacy] text\n\n<!-- lupa:rules:v1:${encoded} -->`)).toBeUndefined();
  });

  it("bounds the complete posted body before decoding", () => {
    const marker = memberRuleMarker(["github-pat"]);
    const body = "x".repeat(60000 - Buffer.byteLength(marker) - 2) + `\n\n${marker}`;
    expect(memberRulesOf(body)).toEqual(["github-pat"]);
    expect(memberRulesOf(`x${body}`)).toBeUndefined();
  });
});
