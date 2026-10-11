import { describe, expect, it } from "vitest";
import { buildBody, eventFor, exitFor, mapToComments, redactFindings } from "../src/review.js";
import { parseHunks } from "../src/diff.js";
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
