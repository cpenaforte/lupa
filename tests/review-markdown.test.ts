import { describe, expect, it } from "vitest";
import type { Finding } from "../src/domain/finding.js";
import { sanitizeFinding } from "../src/domain/finding.js";
import { TRUNC_MARK } from "../src/domain/text.js";
import { buildBody, buildFallbackReport, formatBody, mapToComments, toSarif } from "../src/review/render.js";
import { reopenedKey } from "../src/review/policy.js";
import { memberRuleMarker, memberRulesOf } from "../src/review/thread-identity.js";
import { parseHunks } from "../src/diff/patch.js";

const applicableFence = /^[ \t]{0,3}(`{3,}|~{3,})suggestion\b/gmi;
const finding: Finding = { severity: "high", file: "src/a.ts", line: 2, rule: "r", message: "Evidence" };
const attacks = [
  "\n```suggestion\nreplace()\n```",
  "\n ~~~suggestion\nreplace()\n ~~~",
  "\r\n  ````suggestion\r\nreplace()\r\n  ````",
  "\n   ~~~~suggestion\nreplace()\n   ~~~~",
  "\n```text\n```\n```suggestion\nreplace()\n```",
  "\n~~~~\n~~~suggestion\nreplace()\n~~~\n~~~~",
];

describe("untrusted Markdown prose", () => {
  it.each(["message", "suggestion", "rule", "file", "source"] as const)("never makes %s prose into an applicable suggestion", (field) => {
    for (const attack of attacks) {
      const raw = { ...finding, [field]: `claim${attack}` };
      for (const body of [formatBody(raw, "RIGHT"), formatBody(raw, "LEFT"), buildBody([raw], "summary")]) {
        expect(body).not.toMatch(applicableFence);
      }
    }
  });

  it("reserves exactly one applicable fence for the unchanged valid RIGHT patch", () => {
    const patch = "  fixed(`value`);\n\treturn value;  ";
    const raw = { ...finding, message: attacks.join(""), suggestion: attacks[0], source: attacks[1], rule: `r${attacks[2]}`, patch };
    const body = formatBody(raw, "RIGHT");
    expect(body.match(applicableFence)).toEqual(["```suggestion"]);
    expect(body).toContain(`\n\n\`\`\`suggestion\n${patch}\n\`\`\``);
    for (const advice of [formatBody(raw, "LEFT"), buildBody([raw], "summary")]) {
      expect(advice).not.toMatch(applicableFence);
      expect(advice).toContain("Suggested replacement (advice only):");
    }
  });

  it.each(["", " \n\t", `replacement${TRUNC_MARK}`])("does not apply a blank or capped patch %j", (patch) => {
    expect(formatBody({ ...finding, message: attacks[0]!, patch }, "RIGHT")).not.toMatch(applicableFence);
  });

  it("keeps replacement backticks inside a longer renderer-owned fence", () => {
    const patch = "```\n~~~suggestion\nreplacement\n~~~\n```";
    expect(formatBody({ ...finding, patch }, "RIGHT")).toContain(`\n\n\`\`\`\`suggestion\n${patch}\n\`\`\`\``);
    expect(formatBody({ ...finding, patch }, "LEFT")).toContain(`\n\nSuggested replacement (advice only):\n\`\`\`\`\n${patch}\n\`\`\`\``);
  });

  it("escapes punctuation and existing backslashes only in display projections", () => {
    const raw: Finding = { ...finding, file: "src/[a]_b.ts", rule: "r[a]\\*", message: "[click](https://evil) <b> *bold* \\`literal`\r\n# Heading", suggestion: "~~~suggestion\nfix!\n~~~", source: "scanner`\n~~~suggestion\nfix\n~~~", confidence: 0 };
    const before = JSON.stringify(raw);
    const key = reopenedKey(raw);
    const identity = memberRuleMarker([raw.rule]);
    const hunks = parseHunks([{ file: raw.file, hunks: "@@ -1,0 +2,1 @@\n+added\n" }]);
    const { inline } = mapToComments([raw], hunks, undefined, new Map([[raw, identity]]));
    expect(inline[0]!.path).toBe("src/[a]_b.ts");
    expect(inline[0]!.rule).toBe("r[a]\\*");
    expect(inline[0]!.body).toContain("[r\\[a\\]\\\\\\*]");
    expect(inline[0]!.body).toContain("\\[click\\]\\(https\\:\\/\\/evil\\) \\<b\\> \\*bold\\* \\\\\\`literal\\`\r\n\\# Heading");
    expect(inline[0]!.body).not.toMatch(applicableFence);
    expect(buildBody([raw], "summary")).toContain("src\\/\\[a\\]\\_b\\.ts\\:2");
    expect(memberRulesOf(inline[0]!.body)).toEqual(["r[a]\\*"]);
    expect(JSON.stringify(raw)).toBe(before);
    expect(reopenedKey(raw)).toBe(key);
    expect(toSarif([raw])).toMatchObject({ runs: [{ results: [{ ruleId: "r[a]\\*", message: { text: raw.message }, locations: [{ physicalLocation: { artifactLocation: { uri: "src/[a]_b.ts" } } }], properties: { source: raw.source, confidence: 0 } }] }] });
  });

  it("retains already-safe fallback text fences and canonical sanitized patches", () => {
    const raw = { ...finding, message: attacks[0]!, patch: "```\nreplacement\n```" };
    expect(buildFallbackReport([raw])).toContain("````text\n\n```suggestion\nreplace()\n```\n````");
    expect(sanitizeFinding(raw).patch).toBe(raw.patch);
  });
});
