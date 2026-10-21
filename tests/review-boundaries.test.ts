import { describe, expect, it } from "vitest";
import * as facade from "../src/review.js";
import { eventFor, exitFor, partitionGate } from "../src/review/policy.js";
import { mergeDuplicates } from "../src/review/grouping.js";
import { buildBody, buildFallbackReport, mapToComments } from "../src/review/render.js";
import { capBody } from "../src/review/limits.js";
import { parseHunks } from "../src/diff.js";
import type { Finding } from "../src/domain/finding.js";

describe("review module boundaries", () => {
  it("keeps the compatibility facade bound to the leaf implementations", () => {
    expect(facade.eventFor).toBe(eventFor);
    expect(facade.exitFor).toBe(exitFor);
    expect(facade.partitionGate).toBe(partitionGate);
    expect(facade.mergeDuplicates).toBe(mergeDuplicates);
    expect(facade.buildBody).toBe(buildBody);
    expect(facade.buildFallbackReport).toBe(buildFallbackReport);
    expect(facade.mapToComments).toBe(mapToComments);
    expect(facade.capBody).toBe(capBody);
  });

  it.each([
    { level: "high" as const, severity: "high" as const, event: "REQUEST_CHANGES", exit: 1 },
    { level: "high" as const, severity: "warning" as const, event: "COMMENT", exit: 0 },
    { level: "warning" as const, severity: "warning" as const, event: "COMMENT", exit: 2 },
    { level: "warning" as const, severity: "info" as const, event: "COMMENT", exit: 0 },
    { level: "none" as const, severity: "high" as const, event: "COMMENT", exit: 0 },
  ])("preserves $level policy for $severity evidence", ({ level, severity, event, exit }) => {
    const findings: Finding[] = [{ severity, file: "a.ts", line: 3, rule: "r", message: "m" }];
    expect(eventFor(level, findings)).toBe(event);
    expect(exitFor(level, findings)).toBe(exit);
  });

  it("renders a LEFT deletion as advice while keeping it outside the introduced gate", () => {
    const finding: Finding = { severity: "high", file: "a.ts", line: 3, rule: "r", message: "m", patch: "fixed" };
    const hunks = parseHunks([{ file: "a.ts", hunks: "@@ -3,1 +3,0 @@\n-c\n" }]);
    expect(mapToComments([finding], hunks)).toEqual({
      inline: [{ path: "a.ts", line: 3, side: "LEFT", body: "**high** [r] m\n\nSuggested replacement (advice only):\n```\nfixed\n```", rule: "r" }],
      general: [],
    });
    expect(partitionGate([finding], hunks, [{ file: "a.ts", hunks: "@@ -3,1 +3,0 @@\n-c\n", truncated: false }])).toEqual({
      introduced: [], general: [finding],
    });
  });

  it("retains duplicate severity and the existing general and fallback presentation", () => {
    const findings: Finding[] = [
      { severity: "warning", file: "a.ts", line: 99, rule: "first", message: "warning" },
      { severity: "high", file: "a.ts", line: 99, rule: "second", message: "high" },
    ];
    const result = mergeDuplicates(findings, { pairs: [[0, 1]], links: [], malformed: 0 });
    expect(result).toEqual({ merged: [{ severity: "high", file: "a.ts", line: 99, rule: "first+second", message: "[first] warning\n\n[second] high" }], dropped: 0 });
    expect(mapToComments(result.merged, [])).toEqual({ inline: [], general: result.merged });
    expect(buildBody(result.merged, "summary")).toBe("summary\n\n**Note:** 1 finding(s) below are outside the PR diff and do not block.\n\n**Findings not placed inline:**\n- **high** a\\.ts\\:99 [first\\+second] \\[first\\] warning\n\n\\[second\\] high");
    expect(buildFallbackReport(result.merged)).toBe([
      "lupa: 1 finding(s).", "", "### Finding 1", "", "- Severity: high",
      "- Location:", "```text", "a.ts:99", "```",
      "- Rule:", "```text", "first+second", "```",
      "- Message/evidence:", "```text", "[first] warning", "", "[second] high", "```",
      "- Suggested remediation (advice only):", "```text", "No remediation supplied", "```",
    ].join("\n"));
  });

  it("caps a Unicode message without splitting a surrogate pair", () => {
    // The 57-character note and its newline leave 62 code points for the message.
    expect(capBody("😀".repeat(200), 120, [])).toBe(
      "😀".repeat(62) + "\n> Note: review body truncated to the 120-character limit.",
    );
  });
});
