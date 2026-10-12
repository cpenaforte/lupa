import { describe, expect, it } from "vitest";
import { buildBody, buildFallbackReport, capBody, eventFor, exitFor, isTruncNoteLine, mapToComments, mergeDuplicates, omissionMarkerFor, prioritizeFindings, redactFindings, truncNoteFor } from "../src/review.js";
import { parseHunks } from "../src/diff.js";
import type { DedupVerdicts } from "../src/llm.js";
import type { Finding } from "../src/fastpath.js";

// a.ts: line 3 is a deletion (LEFT 3), line 4 an addition (RIGHT 4); line 99 is outside every hunk.
function hunksFixture() {
  return parseHunks([{ file: "a.ts", hunks: "@@ -3,1 +3,0 @@\n-c\n@@ -10,0 +4,1 @@\n+d\n" }]);
}
// a.ts: 3-line addition range at RIGHT 8-10.
function rangeFixture() {
  return parseHunks([{ file: "a.ts", hunks: "@@ -7,0 +8,3 @@\n+x\n+y\n+z\n" }]);
}
function highFinding(): Finding[] {
  return [{ severity: "high", file: "a.ts", line: 4, rule: "r", message: "m" }];
}

describe("buildFallbackReport", () => {
  it("renders every finding once in input order with all report fields", () => {
    const inline: Finding = { severity: "warning", file: "src/a.ts", line: 2, rule: "logic", message: "first evidence", suggestion: "apply first fix" };
    const general: Finding = { severity: "high", file: "", rule: "repository-rule", message: "second evidence" };
    const report = buildFallbackReport([inline, general]);
    expect(report).toContain("lupa: 2 finding(s).");
    expect(report).toContain("### Finding 1");
    expect(report).toContain("### Finding 2");
    for (const value of ["warning", "src/a.ts:2", "logic", "first evidence", "apply first fix", "high", "(repository)", "repository-rule", "second evidence", "No remediation supplied"]) expect(report).toContain(value);
    expect(report.indexOf("first evidence")).toBeLessThan(report.indexOf("second evidence"));
    expect(report.match(/first evidence/g)).toHaveLength(1);
    expect(report.match(/second evidence/g)).toHaveLength(1);
  });

  it("renders the no-findings heading", () => {
    expect(buildFallbackReport([])).toBe("lupa: no findings.");
  });

  it("renders file-only and repository locations and explicit missing remediation", () => {
    const fileOnly = buildFallbackReport([{ severity: "info", file: "b.ts", rule: "line-less", message: "file evidence" }]);
    expect(fileOnly).toContain("b.ts");
    expect(fileOnly).toContain("No remediation supplied");
    const repository = buildFallbackReport([{ severity: "info", file: "", rule: "repo", message: "repo evidence" }]);
    expect(repository).toContain("(repository)");
  });

  it("contains hostile Markdown and multiline values in dynamic text fences", () => {
    const finding: Finding = { severity: "warning", file: "src/a.ts```\nmalicious", line: 2, rule: "rule````", message: "first line\n**bold** ```\n## fake heading", suggestion: "change ```\n- fake item" };
    const report = buildFallbackReport([finding]);
    expect(report).toContain("lupa: 1 finding(s).");
    expect(report).toContain("- Location:\n````text\nsrc/a.ts```\nmalicious:2\n````");
    expect(report).toContain("- Rule:\n`````text\nrule````\n`````");
    expect(report).toContain("- Message/evidence:\n````text\nfirst line\n**bold** ```\n## fake heading\n````");
    expect(report).toContain("- Suggested remediation (advice only):\n````text\nchange ```\n- fake item\n````");
    expect(report).not.toContain("suggestion\n");
  });

  it("fits the exact UTF-8 limit and reports omissions one byte below it", () => {
    const first: Finding = { severity: "info", file: "α.ts", line: 2, rule: "first", message: "evidence é" };
    const second: Finding = { severity: "warning", file: "b.ts", rule: "second", message: "é".repeat(256) };
    const findings = [first, second];
    const full = buildFallbackReport(findings);
    const fullBytes = Buffer.byteLength(full, "utf8");
    expect(buildFallbackReport(findings, { maxBytes: fullBytes })).toBe(full);
    const markerOne = "> Omitted: 1 finding(s) omitted because the report output limit was reached.";
    const firstRecordAndMarker = ["lupa: 2 finding(s).", "", "### Finding 1", "", "- Severity: info", "- Location:", "```text", "α.ts:2", "```", "- Rule:", "```text", "first", "```", "- Message/evidence:", "```text", "evidence é", "```", "- Suggested remediation (advice only):", "```text", "No remediation supplied", "```", "", markerOne].join("\n");
    const oneByteShort = buildFallbackReport(findings, { maxBytes: fullBytes - 1 });
    expect(oneByteShort).toBe(firstRecordAndMarker);
    expect(Buffer.byteLength(oneByteShort, "utf8")).toBeLessThanOrEqual(fullBytes - 1);
  });

  it("permits zero retained records when the heading and marker fit", () => {
    const first: Finding = { severity: "info", file: "α.ts", line: 2, rule: "first", message: "evidence é" };
    const second: Finding = { severity: "warning", file: "b.ts", rule: "second", message: "é".repeat(256) };
    const findings = [first, second];
    const zeroRecords = "lupa: 2 finding(s).\n\n> Omitted: 2 finding(s) omitted because the report output limit was reached.";
    const minimumBytes = Buffer.byteLength(zeroRecords, "utf8");
    expect(buildFallbackReport(findings, { maxBytes: minimumBytes })).toBe(zeroRecords);
    expect(() => buildFallbackReport(findings, { maxBytes: minimumBytes - 1 })).toThrow(RangeError);
    expect(buildFallbackReport([], { maxBytes: Buffer.byteLength("lupa: no findings.", "utf8") })).toBe("lupa: no findings.");
    expect(() => buildFallbackReport([], { maxBytes: Buffer.byteLength("lupa: no findings.", "utf8") - 1 })).toThrow(RangeError);
  });

  it("rejects invalid and undersized byte limits", () => {
    const first: Finding = { severity: "info", file: "a.ts", rule: "r", message: "m" };
    for (const maxBytes of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) expect(() => buildFallbackReport([first], { maxBytes })).toThrow(RangeError);
    const minimum = Buffer.byteLength("lupa: 1 finding(s).\n\n> Omitted: 1 finding(s) omitted because the report output limit was reached.", "utf8");
    expect(() => buildFallbackReport([first], { maxBytes: minimum - 1 })).toThrow(RangeError);
  });
});

describe("mapToComments", () => {
  it("deletion maps LEFT, addition RIGHT, off-diff goes general", () => {
    const del = mapToComments([{ severity: "high", file: "a.ts", line: 3, rule: "r", message: "m" }], hunksFixture());
    expect(del.inline[0].side).toBe("LEFT");
    expect("position" in (del.inline[0] as object)).toBe(false);
    expect(del.inline[0].body).toBeTruthy();
    const add = mapToComments([{ severity: "info", file: "a.ts", line: 4, rule: "r", message: "m" }], hunksFixture());
    expect(add.inline[0].side).toBe("RIGHT");
    const off = mapToComments([{ severity: "info", file: "a.ts", line: 99, rule: "r", message: "m" }], hunksFixture());
    expect(off.inline).toEqual([]);
    expect(off.general.map((f) => f.file)).toContain("a.ts");
  });

  it("v1 never emits start_line/start_side, with or without a suggestion on a multi-line run", () => {
    const withSuggestion = mapToComments(
      [{ severity: "warning", file: "a.ts", line: 10, rule: "r", message: "m", suggestion: "s" }],
      rangeFixture(),
    );
    expect(withSuggestion.inline).toHaveLength(1);
    expect(withSuggestion.inline[0].line).toBe(10);
    expect(withSuggestion.inline[0].side).toBe("RIGHT");
    expect("start_line" in withSuggestion.inline[0]).toBe(false);
    expect("start_side" in withSuggestion.inline[0]).toBe(false);

    const withoutSuggestion = mapToComments(
      [{ severity: "warning", file: "a.ts", line: 10, rule: "r", message: "m" }],
      rangeFixture(),
    );
    expect("start_line" in withoutSuggestion.inline[0]).toBe(false);
    expect("start_side" in withoutSuggestion.inline[0]).toBe(false);
  });

  it("RIGHT suggestion renders a ```suggestion fence", () => {
    const r = mapToComments(
      [{ severity: "warning", file: "a.ts", line: 10, rule: "r", message: "m", suggestion: "fixed" }],
      rangeFixture(),
    );
    expect(r.inline[0].body).toContain("```suggestion\nfixed\n```");
  });

  it("LEFT suggestion renders plain text, never a fence", () => {
    const r = mapToComments(
      [{ severity: "high", file: "a.ts", line: 3, rule: "r", message: "m", suggestion: "fixed" }],
      hunksFixture(),
    );
    expect(r.inline[0].side).toBe("LEFT");
    expect(r.inline[0].body).not.toContain("```");
    expect(r.inline[0].body).not.toContain("suggestion");
    expect(r.inline[0].body).toContain("Suggested: fixed");
  });

  it("LEFT multi-line suggestion indents continuation lines", () => {
    const r = mapToComments(
      [{ severity: "high", file: "a.ts", line: 3, rule: "r", message: "m", suggestion: "a\nb" }],
      hunksFixture(),
    );
    expect(r.inline[0].side).toBe("LEFT");
    expect(r.inline[0].body).toContain("Suggested: a\n  b");
    expect(r.inline[0].body).not.toContain("```");
  });

  it("suggestion containing backticks gets a longer fence that cannot be closed early", () => {
    const suggestion = "a ```js\nx\n```";
    const r = mapToComments(
      [{ severity: "warning", file: "a.ts", line: 10, rule: "r", message: "m", suggestion }],
      rangeFixture(),
    );
    const body = r.inline[0].body;
    expect(body).toContain("````suggestion\n" + suggestion + "\n````");
    expect(body.endsWith("````")).toBe(true);
  });

  it("same line number on both sides: RIGHT wins deterministically", () => {
    // Hunk turns old line 3 into new line 3: LEFT 3 (del) and RIGHT 3 (add) both exist.
    const hunks = parseHunks([{ file: "a.ts", hunks: "@@ -3,1 +3,1 @@\n-old\n+new\n" }]);
    const r = mapToComments([{ severity: "info", file: "a.ts", line: 3, rule: "r", message: "m" }], hunks);
    expect(r.inline).toHaveLength(1);
    expect(r.inline[0].side).toBe("RIGHT");
  });

  it("repo-level (file \"\") and line-less findings go general", () => {
    const r = mapToComments(
      [
        { severity: "warning", file: "", rule: "r", message: "repo" },
        { severity: "info", file: "a.ts", rule: "r", message: "no line" },
      ],
      hunksFixture(),
    );
    expect(r.inline).toEqual([]);
    expect(r.general).toHaveLength(2);
  });

  it("null line + suggestion goes general and the suggestion is plain text there", () => {
    const f = {
      severity: "info",
      file: "a.ts",
      line: null,
      suggestion: "s",
      rule: "r",
      message: "m",
    } as unknown as Finding;
    const r = mapToComments([f], hunksFixture());
    expect(r.inline).toEqual([]);
    expect(r.general).toHaveLength(1);
    const body = buildBody(r.general, "sum");
    expect(body).toContain("Suggested: s");
    expect(body).not.toContain("```");
  });
});

describe("parseHunks", () => {
  it("assigns side per line and ignores the no-newline marker", () => {
    const h = parseHunks([{ file: "b.ts", hunks: "@@ -1,2 +1,2 @@\n ctx\n-old\n+new\n\\ No newline at end of file\n" }]);
    expect(h).toHaveLength(1);
    expect(h[0].file).toBe("b.ts");
    expect(h[0].lines).toEqual([
      { side: "RIGHT", line: 1, kind: "ctx" },
      { side: "LEFT", line: 2, kind: "del" },
      { side: "RIGHT", line: 2, kind: "add" },
    ]);
  });

  it("multi-hunk: each hunk restarts numbering from its own header", () => {
    const h = parseHunks([
      { file: "m.ts", hunks: "@@ -1,2 +1,2 @@\n a\n-b\n+c\n@@ -50,1 +60,2 @@\n-d\n+e\n+f\n" },
    ]);
    expect(h).toHaveLength(2);
    expect(h[0].lines).toEqual([
      { side: "RIGHT", line: 1, kind: "ctx" },
      { side: "LEFT", line: 2, kind: "del" },
      { side: "RIGHT", line: 2, kind: "add" },
    ]);
    expect(h[1].lines).toEqual([
      { side: "LEFT", line: 50, kind: "del" },
      { side: "RIGHT", line: 60, kind: "add" },
      { side: "RIGHT", line: 61, kind: "add" },
    ]);
  });

  it("count-less header `@@ -3 +9 @@` is parsed (count defaults to 1)", () => {
    const h = parseHunks([{ file: "c.ts", hunks: "@@ -3 +9 @@\n-x\n+y\n" }]);
    expect(h[0].lines).toEqual([
      { side: "LEFT", line: 3, kind: "del" },
      { side: "RIGHT", line: 9, kind: "add" },
    ]);
  });
});

describe("buildBody", () => {
  it("is never empty", () => {
    expect(buildBody([], "").length).toBeGreaterThan(0);
    expect(buildBody([], "   ").length).toBeGreaterThan(0);
  });

  it("appends general findings to the summary with file:line locators", () => {
    const body = buildBody([{ severity: "warning", file: "a.ts", line: 99, rule: "r", message: "off diff" }], "Summary");
    expect(body).toContain("Summary");
    expect(body).toContain("off diff");
    expect(body).toContain("a.ts:99");
  });

  it("locator: file without line, and (repository) for repo-level", () => {
    const body = buildBody(
      [
        { severity: "info", file: "b.ts", rule: "r", message: "no line" },
        { severity: "info", file: "", rule: "r", message: "repo wide" },
      ],
      "S",
    );
    expect(body).toContain("b.ts [r] no line");
    expect(body).toContain("(repository) [r] repo wide");
  });
});

describe("redactFindings", () => {
  it("redactFindings replaces secrets in message, suggestion, file and rule", () => {
    const out = redactFindings(
      [
        {
          severity: "warning",
          file: "src/sk-secret-1.ts",
          line: 1,
          rule: "rule-sk-secret-1",
          message: "saw sk-secret-1 in code",
          suggestion: "rotate sk-secret-1 now",
        },
      ],
      ["sk-secret-1"],
    );
    expect(out).toEqual([
      {
        severity: "warning",
        file: "src/[REDACTED].ts",
        line: 1,
        rule: "rule-[REDACTED]",
        message: "saw [REDACTED] in code",
        suggestion: "rotate [REDACTED] now",
      },
    ]);
  });

  it("redactFindings ignores empty secrets", () => {
    const findings: Finding[] = [{ severity: "warning", file: "a.ts", line: 1, rule: "r", message: "m" }];
    expect(redactFindings(findings, [""])).toEqual(findings);
    expect(redactFindings(findings, [])).toEqual(findings);
  });
});

describe("eventFor", () => {
  it("warning never requests changes; none never blocks; never APPROVE", () => {
    expect(eventFor("warning", highFinding())).toBe("COMMENT");
    expect(eventFor("none", highFinding())).toBe("COMMENT");
    expect(eventFor("high", [])).toBe("COMMENT");
    expect(eventFor("high", highFinding())).toBe("REQUEST_CHANGES");
  });

  it("high without high evidence is COMMENT", () => {
    expect(eventFor("high", [{ severity: "warning", file: "a", rule: "r", message: "m" }])).toBe("COMMENT");
  });
});

describe("exitFor", () => {
  it("exit codes pinned: none 0, warning 2 only above info, high 1 with evidence", () => {
    expect(exitFor("none", highFinding())).toBe(0);
    expect(exitFor("warning", [])).toBe(0);
    expect(exitFor("warning", [{ severity: "info", file: "a", rule: "r", message: "m" }])).toBe(0);
    expect(exitFor("warning", highFinding())).toBe(2);
    expect(exitFor("high", [{ severity: "warning", file: "a", rule: "r", message: "m" }])).toBe(0);
    expect(exitFor("high", [{ severity: "info", file: "a", rule: "r", message: "m" }])).toBe(0);
    expect(exitFor("high", highFinding())).toBe(1);
    expect(exitFor("high", [])).toBe(0);
  });
});

describe("prioritizeFindings", () => {
  it("orders high before warning before info and keeps ties stable", () => {
    const findings: Finding[] = [
      { severity: "info", file: "a", rule: "r", message: "i1" },
      { severity: "high", file: "b", rule: "r", message: "h1" },
      { severity: "warning", file: "c", rule: "r", message: "w1" },
      { severity: "high", file: "d", rule: "r", message: "h2" },
      { severity: "info", file: "e", rule: "r", message: "i2" },
      { severity: "warning", file: "f", rule: "r", message: "w2" },
    ];
    const ordered = prioritizeFindings(findings);
    expect(ordered.map((f) => f.message)).toEqual(["h1", "h2", "w1", "w2", "i1", "i2"]);
    // Input order is untouched (a new array is returned).
    expect(findings.map((f) => f.message)).toEqual(["i1", "h1", "w1", "h2", "i2", "w2"]);
  });
});

describe("publication markers", () => {
  it("pins the exact omission and truncation strings", () => {
    expect(omissionMarkerFor(300, 200)).toBe(
      "> Omitted: 300 finding(s) omitted to fit the 200-finding publication limit.",
    );
    expect(truncNoteFor(60000)).toBe("> Note: review body truncated to the 60000-character limit.");
    expect(isTruncNoteLine("> Note: review body truncated to the 60000-character limit.")).toBe(true);
    expect(isTruncNoteLine("> Note: review body truncated to the abc-character limit.")).toBe(false);
    expect(isTruncNoteLine("  > Note: review body truncated to the 60000-character limit.")).toBe(false);
  });
});

describe("capBody", () => {
  const cps = (s: string): number => Array.from(s).length;
  const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  it("appends markers in argument order even when the content fits", () => {
    expect(capBody("short", 60000, ["M1", "M2"])).toBe("short\nM1\nM2");
  });

  it("returns the body unchanged when it fits with no markers", () => {
    expect(capBody("lupa: no findings.", 60000, [])).toBe("lupa: no findings.");
  });

  it("passes through a fitting CRLF body byte-for-byte (same reference)", () => {
    const body = "line-one\r\nline-two\r\nline-three";
    const out = capBody(body, 60000, []);
    expect(out).toBe(body);
    expect(out === body).toBe(true);
  });

  it("leaves marker-looking lines alone when nothing is capped and markers is empty", () => {
    const marker = omissionMarkerFor(5, 200);
    const body = `content\n${marker}`;
    const out = capBody(body, 60000, []);
    expect(out).toBe(body);
    expect(out === body).toBe(true);
  });

  it("cuts whole lines and keeps markers plus a trailing note inside the cap", () => {
    const body = ["lupa: 3 finding(s).", "", "line-aaaaaaaaaaaaaaaa", "line-bbbbbbbbbbbbbbbb", "line-cccccccccccccccc", "line-dddddddddddddddd"].join("\n");
    const marker = omissionMarkerFor(5, 200);
    const out = capBody(body, 160, [marker]);
    expect(cps(out)).toBeLessThanOrEqual(160);
    expect(out).toContain(marker);
    expect(out.endsWith(truncNoteFor(160))).toBe(true);
    // Whole-line cut: no partial line survives before the marker block.
    const content = out.slice(0, out.indexOf(marker));
    for (const line of content.split("\n").filter((l) => l !== "")) {
      expect(body.split("\n")).toContain(line);
    }
  });

  it("cuts a single over-long line mid-line, code-point-safe", () => {
    const note = truncNoteFor(120);
    const out = capBody("x".repeat(200), 120, []);
    expect(cps(out)).toBe(120);
    // The note is a line of its own: the separator newline is part of the cap.
    expect(out).toBe(`${"x".repeat(120 - cps(note) - 1)}\n${note}`);
  });

  it("never splits a surrogate pair on a mid-line emoji cut", () => {
    const note = truncNoteFor(120);
    const out = capBody("😀".repeat(200), 120, []);
    expect(cps(out)).toBe(120);
    expect(out).toBe(`${"😀".repeat(120 - cps(note) - 1)}\n${note}`);
    expect(loneSurrogate.test(out)).toBe(false);
  });

  it("backs up before the opening fence line when the cut lands inside a fence block", () => {
    const body = `lupa: 1 finding(s).\n\n\`\`\`suggestion\n${"code-line\n".repeat(30)}\`\`\`\ntail\n`;
    const out = capBody(body, 120, []);
    expect(cps(out)).toBeLessThanOrEqual(120);
    expect(out).toContain("lupa: 1 finding(s).");
    expect(out).not.toContain("```suggestion");
    expect(out.endsWith(truncNoteFor(120))).toBe(true);
    const fences = out.split("\n").filter((l) => l.trimStart().startsWith("```")).length;
    expect(fences % 2).toBe(0);
  });

  it("strips stale trunc-notes without emitting a fresh one when nothing is cut", () => {
    const stale = "content line\n> Note: review body truncated to the 99999-character limit.";
    expect(capBody(stale, 60000, [])).toBe("content line");
  });

  it("emits exactly one fresh note when a stale-noted body is cut again", () => {
    const body = `${"y".repeat(200)}\n> Note: review body truncated to the 99999-character limit.`;
    const out = capBody(body, 120, []);
    expect(out.match(/^> Note: review body truncated to the \d+-character limit\.$/gm)).toHaveLength(1);
    expect(out.endsWith(truncNoteFor(120))).toBe(true);
    expect(cps(out)).toBeLessThanOrEqual(120);
  });

  it("extracts body omission lines as markers without duplicating a passed marker", () => {
    const marker = omissionMarkerFor(5, 200);
    const out = capBody(`content\n${marker}`, 60000, [marker]);
    expect(out).toBe(`content\n${marker}`);
  });

  it("guarantees markers inside the cap on a long body", () => {
    const marker = omissionMarkerFor(300, 200);
    const out = capBody(`${"line\n".repeat(500)}`, 1000, [marker]);
    expect(cps(out)).toBeLessThanOrEqual(1000);
    expect(out).toContain(marker);
    expect(out.endsWith(truncNoteFor(1000))).toBe(true);
  });

  it("throws RangeError when the markers alone exceed the cap", () => {
    const big = `> Omitted: ${"9".repeat(50)} finding(s) omitted to fit the 200-finding publication limit.`;
    expect(() => capBody("body", 10, [big])).toThrow(RangeError);
  });
});

describe("mergeDuplicates", () => {
  const F = (
    severity: Finding["severity"],
    file: string,
    line: number | undefined,
    rule: string,
    message: string,
    suggestion?: string,
  ): Finding => ({
    severity,
    file,
    ...(line !== undefined ? { line } : {}),
    rule,
    message,
    ...(suggestion !== undefined ? { suggestion } : {}),
  });
  const V = (pairs: Array<[number, number]> = [], links: Array<[number, number]> = [], malformed = 0): DedupVerdicts => ({
    pairs,
    links,
    malformed,
  });

  it("merges the canary pair into one high finding with a collapsed rule and redaction kept", () => {
    const gitleaks = F("high", "src/leak.py", 7, "github-pat", "Artifact: leak.py … Match: [REDACTED]");
    const semgrep = F("warning", "src/leak.py", 7, "github-pat", "github-pat has detected secret for file /src/leak.py: [REDACTED]");
    const { merged, dropped } = mergeDuplicates([gitleaks, semgrep], V([[0, 1]]));
    expect(dropped).toBe(0);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ severity: "high", file: "src/leak.py", line: 7, rule: "github-pat" });
    expect(merged[0]!.message).toContain("Artifact: leak.py");
    expect(merged[0]!.message).toContain("has detected secret");
    expect(merged[0]!.message).toContain("[REDACTED]");
  });

  it("merges a model finding into a scanner finding via an absolute duplicateOf link", () => {
    const scan = F("warning", "src/a.ts", 1, "scan-rule", "scanner evidence");
    const other = F("info", "src/a.ts", 9, "other-rule", "unrelated");
    const model = F("warning", "src/a.ts", 1, "llm-rule", "model restatement");
    const { merged, dropped } = mergeDuplicates([scan, other, model], V([], [[2, 0]]));
    expect(dropped).toBe(0);
    expect(merged).toHaveLength(2);
    expect(merged[0]!.rule).toBe("scan-rule+llm-rule");
    expect(merged[0]!.message).toContain("scanner evidence");
    expect(merged[0]!.message).toContain("model restatement");
    expect(merged[1]).toEqual(other);
  });

  it("closes transitively over absolute positions (triple to one)", () => {
    const fs = [F("info", "a.ts", 1, "r0", "m0"), F("warning", "a.ts", 1, "r1", "m1"), F("high", "a.ts", 1, "r2", "m2")];
    const { merged, dropped } = mergeDuplicates(fs, V([[0, 1], [1, 2]]));
    expect(dropped).toBe(0);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.severity).toBe("high");
    expect(merged[0]!.rule).toBe("r0+r1+r2");
  });

  it("checks the precondition per pair before closure: A~B merges while cross-file B~C leaves C alone", () => {
    const a = F("warning", "a.ts", 1, "ra", "ma");
    const b = F("warning", "a.ts", 1, "rb", "mb");
    const c = F("warning", "b.ts", 1, "rc", "mc");
    const { merged, dropped } = mergeDuplicates([a, b, c], V([[0, 1], [1, 2]]));
    expect(dropped).toBe(1);
    expect(merged).toHaveLength(2);
    expect(merged[0]!.rule).toBe("ra+rb");
    expect(merged[0]!.message).toContain("ma");
    expect(merged[0]!.message).toContain("mb");
    expect(merged[1]).toEqual(c);
  });

  it("ignores a same-file pair on different lines and counts it", () => {
    const fs = [F("warning", "a.ts", 1, "r0", "m0"), F("warning", "a.ts", 2, "r1", "m1")];
    const { merged, dropped } = mergeDuplicates(fs, V([[0, 1]]));
    expect(dropped).toBe(1);
    expect(merged).toEqual(fs);
  });

  it("ignores a pair mixing a defined and an undefined line", () => {
    const fs = [F("warning", "a.ts", 1, "r0", "m0"), F("warning", "a.ts", undefined, "r1", "m1")];
    const { merged, dropped } = mergeDuplicates(fs, V([[0, 1]]));
    expect(dropped).toBe(1);
    expect(merged).toEqual(fs);
  });

  it("merges line-less findings on the same file", () => {
    const fs = [F("warning", "a.ts", undefined, "r0", "m0"), F("warning", "a.ts", undefined, "r1", "m1")];
    const { merged, dropped } = mergeDuplicates(fs, V([[0, 1]]));
    expect(dropped).toBe(0);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.line).toBeUndefined();
  });

  it("drops a partially-valid pair whole: the valid member stays alone", () => {
    const fs = [F("warning", "a.ts", 1, "r0", "m0"), F("warning", "a.ts", 1, "r1", "m1")];
    const { merged, dropped } = mergeDuplicates(fs, V([[0, 5]]));
    expect(dropped).toBe(1);
    expect(merged).toEqual(fs);
  });

  it("drops an out-of-range link whole and counts it", () => {
    const fs = [F("warning", "a.ts", 1, "r0", "m0"), F("warning", "a.ts", 1, "r1", "m1")];
    const { merged, dropped } = mergeDuplicates(fs, V([], [[7, 8]]));
    expect(dropped).toBe(1);
    expect(merged).toEqual(fs);
  });

  it("re-caps joined rules at the rule cap with the marker", () => {
    const fs = [F("warning", "a.ts", 1, "r".repeat(60), "m0"), F("warning", "a.ts", 1, "s".repeat(60), "m1")];
    const { merged, dropped } = mergeDuplicates(fs, V([[0, 1]]));
    expect(dropped).toBe(0);
    expect(Array.from(merged[0]!.rule).length).toBeLessThanOrEqual(100);
    expect(merged[0]!.rule).toContain("…[truncated]");
  });

  it("re-caps joined messages at the message cap with the marker", () => {
    const fs = [F("warning", "a.ts", 1, "r", "m".repeat(1500)), F("warning", "a.ts", 1, "r", "n".repeat(1500))];
    const { merged, dropped } = mergeDuplicates(fs, V([[0, 1]]));
    expect(dropped).toBe(0);
    expect(Array.from(merged[0]!.message).length).toBeLessThanOrEqual(2000);
    expect(merged[0]!.message).toContain("…[truncated]");
  });

  it("keeps the first defined suggestion in group order", () => {
    const withFirst = [F("warning", "a.ts", 1, "r0", "m0", "fix-a"), F("warning", "a.ts", 1, "r1", "m1", "fix-b")];
    expect(mergeDuplicates(withFirst, V([[0, 1]])).merged[0]!.suggestion).toBe("fix-a");
    const withSecond = [F("warning", "a.ts", 1, "r0", "m0"), F("warning", "a.ts", 1, "r1", "m1", "fix-b")];
    expect(mergeDuplicates(withSecond, V([[0, 1]])).merged[0]!.suggestion).toBe("fix-b");
    const withNone = [F("warning", "a.ts", 1, "r0", "m0"), F("warning", "a.ts", 1, "r1", "m1")];
    expect(mergeDuplicates(withNone, V([[0, 1]])).merged[0]!.suggestion).toBeUndefined();
  });

  it("emits groups in first-member-position order (stable, deterministic)", () => {
    const fs = [F("info", "a.ts", 1, "ra", "ma"), F("info", "a.ts", 1, "rb", "mb"), F("info", "b.ts", 2, "rc", "mc"), F("info", "b.ts", 2, "rd", "md")];
    const { merged } = mergeDuplicates(fs, V([[2, 3], [0, 1]]));
    expect(merged).toHaveLength(2);
    expect(merged[0]!.message).toContain("ma");
    expect(merged[1]!.message).toContain("mc");
  });

  it("passes empty verdicts through untouched", () => {
    const fs = [F("warning", "a.ts", 1, "r0", "m0"), F("warning", "a.ts", 1, "r1", "m1")];
    const { merged, dropped } = mergeDuplicates(fs, V());
    expect(dropped).toBe(0);
    expect(merged).toEqual(fs);
  });

  it("takes the maximum severity across the group", () => {
    const fs = [F("info", "a.ts", 1, "r0", "m0"), F("warning", "a.ts", 1, "r1", "m1")];
    expect(mergeDuplicates(fs, V([[0, 1]])).merged[0]!.severity).toBe("warning");
  });
});
