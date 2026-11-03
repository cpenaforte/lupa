import { describe, expect, it } from "vitest";
import * as domainFinding from "../src/domain/finding.js";
import { capText } from "../src/domain/text.js";
import * as domainText from "../src/domain/text.js";
import * as legacyFastpath from "../src/fastpath.js";
import * as legacyMain from "../src/main.js";
import * as legacyLlm from "../src/llm.js";

describe("domain text normalization", () => {
  it("redacts every literal occurrence, including adjacent secrets and regex metacharacters", () => {
    expect(domainText.redact("a.b/a.ba.b", "a.b")).toBe("[REDACTED]/[REDACTED][REDACTED]");
  });

  it("preserves the existing empty-key split behavior", () => {
    expect(domainText.redact("abc", "")).toBe("a[REDACTED]b[REDACTED]c");
    expect(domainText.redact("", "")).toBe("");
  });

  it("caps Unicode text by code points with the truncation marker inside the cap", () => {
    const capped = capText("😀".repeat(2001), 2000);
    expect(Array.from(capped)).toHaveLength(2000);
    expect(capped.endsWith("…[truncated]")).toBe(true);
    expect(capped).toBe("😀".repeat(1988) + "…[truncated]");
    expect(capText("😀".repeat(2000), 2000)).toBe("😀".repeat(2000));
  });
});

describe("domain finding normalization", () => {
  it.each(["/etc/passwd", "C:\\private\\key", "\\server\\key", "src/../key", "src/..\u0000/key"])(
    "turns unsafe path %s into a repository note after stripping controls",
    (file) => {
      const finding: domainFinding.Finding = {
        severity: "high", file, line: 3, rule: "se\u0000cret", message: "a\u0000b\n\tc",
        suggestion: "fix\u0000\n\there", patch: "code\u0000\n", source: "scan\u0000ner",
        confidence: 73, evidence: { analyzer: "tool\u0000", snippet: "proof\u0000\n" },
      };
      expect(domainFinding.sanitizeFinding(finding)).toEqual({
        severity: "high", file: "", rule: "secret", message: "artifact path rejected: ab\n\tc",
        suggestion: "fix\n\there", patch: "code\n", source: "scanner", confidence: 73,
        evidence: { analyzer: "tool", snippet: "proof\n" },
      });
      expect(finding.file).toBe(file);
      expect(finding.line).toBe(3);
    },
  );

  it("strips provenance in place while retaining the finding and patch", () => {
    const finding: domainFinding.Finding = {
      severity: "warning", file: "src/a.ts", rule: "logic", message: "check", patch: "replacement",
      source: "llm", confidence: 80, evidence: { analyzer: "tool" },
    };
    expect(domainFinding.stripProvenance(finding)).toBe(finding);
    expect(finding).toEqual({
      severity: "warning", file: "src/a.ts", rule: "logic", message: "check", patch: "replacement",
    });
  });
});

describe("legacy compatibility exports", () => {
  it("keeps the same normalization function objects at the old and domain paths", () => {
    expect(legacyMain.sanitizeFinding).toBe(domainFinding.sanitizeFinding);
    expect(legacyFastpath.stripProvenance).toBe(domainFinding.stripProvenance);
    expect(legacyFastpath.capText).toBe(domainText.capText);
    expect(legacyLlm.redact).toBe(domainText.redact);
  });
});
