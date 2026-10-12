import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  filterForPrompt,
  truncateDiff,
  parseRename,
  writePrMeta,
  readPrMeta,
  type FileDiff,
  type PrMeta,
} from "../src/diff.js";

// Local fixture (do NOT import from review.js — Task 10 owns it).
function hunksFor(file: string): { file: string; header: string; body: string }[] {
  return [{ file, header: "@@ -1 +1 @@", body: "-a\n+b\n" }];
}

describe("diff", () => {
  it("prompt filter drops lock/minified/map/binaries from prompt (L0 runs unfiltered)", () => {
    const F = (file: string, binary = false) => ({ file, hunks: "", truncated: false, binary });
    expect(
      filterForPrompt([F("src/a.ts"), F("package-lock.json"), F("dist/b.min.js"), F("a.map")]).map(
        (f) => f.file,
      ),
    ).toEqual(["src/a.ts"]);
    expect(filterForPrompt([F("img.png", true), F("package-lock.json")])).toEqual([]);
    const { text } = truncateDiff(
      [{ file: "big.ts", hunks: "x".repeat(20000), truncated: false }],
      60000,
      8000,
    );
    expect(text.length).toBeLessThanOrEqual(8000);
  });

  it("follows renames via parseRename (new path), both formats", () => {
    const r = parseRename("R100\told/a.ts\tnew/a.ts\nM\tsrc/b.ts");
    expect(r).toEqual([{ oldPath: "old/a.ts", newPath: "new/a.ts" }]);
    const h = parseRename("rename from old/c.ts\nrename to new/c.ts\n");
    expect(h).toEqual([{ oldPath: "old/c.ts", newPath: "new/c.ts" }]);
    expect(hunksFor("new/a.ts")[0].file).toBe("new/a.ts");
  });

  it("truncateDiff respects global maxChars and records skipped files", () => {
    const files: FileDiff[] = [
      { file: "a.ts", hunks: "y".repeat(400), truncated: false },
      { file: "b.ts", hunks: "y".repeat(400), truncated: false },
      { file: "c.ts", hunks: "y".repeat(400), truncated: false },
    ];
    const { text, skipped } = truncateDiff(files, 1000, 8000);
    expect(text.length).toBeLessThanOrEqual(1000);
    expect(skipped).toEqual(["c.ts"]);
    expect(text).toContain("a.ts");
    expect(text).toContain("b.ts");
  });

  it("filterForPrompt keeps hunks and files untouched on the survivors", () => {
    const f: FileDiff = { file: "src/x.ts", hunks: "@@ keep @@", truncated: true, size: 12 };
    expect(filterForPrompt([f])).toEqual([f]);
  });

  it("parseRename ignores non-rename lines and returns [] when none", () => {
    expect(parseRename("M\ta.ts\nA\tb.ts\n")).toEqual([]);
    expect(parseRename("")).toEqual([]);
  });

  it("pr-meta write/read roundtrip", () => {
    const dir = mkdtempSync(join(tmpdir(), "prmeta-"));
    try {
      const m: PrMeta = {
        pr_number: 42,
        head_sha: "a".repeat(40),
        base_sha: "b".repeat(40),
        head_repo_full_name: "org/fork",
        is_fork: true,
      };
      writePrMeta(m, dir);
      expect(readPrMeta(dir)).toEqual(m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parseRename handles CRLF line endings", () => {
    const r = parseRename("R100\told/a.ts\tnew/a.ts\r\nM\tsrc/b.ts\r\n");
    expect(r).toEqual([{ oldPath: "old/a.ts", newPath: "new/a.ts" }]);
    const h = parseRename("rename from old/c.ts\r\nrename to new/c.ts\r\n");
    expect(h).toEqual([{ oldPath: "old/c.ts", newPath: "new/c.ts" }]);
  });

  it("filterForPrompt keeps binary:false files with image extensions (flag decides, not extension)", () => {
    const f: FileDiff = { file: "x.png", hunks: "", truncated: false, binary: false };
    expect(filterForPrompt([f])).toEqual([f]);
  });

  it("readPrMeta throws a clean error on malformed JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "prmeta-"));
    try {
      writeFileSync(join(dir, "pr-meta.json"), "{not json", "utf8");
      expect(() => readPrMeta(dir)).toThrow(/Invalid pr-meta\.json/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(["null", "[]", "42", '"str"'])(
    "readPrMeta throws a clean error when JSON body is %s",
    (body) => {
      const dir = mkdtempSync(join(tmpdir(), "prmeta-"));
      try {
        writeFileSync(join(dir, "pr-meta.json"), body, "utf8");
        expect(() => readPrMeta(dir)).toThrow(/Invalid pr-meta\.json/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("readPrMeta returns undefined when no pr-meta file exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "prmeta-"));
    try {
      expect(readPrMeta(dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("readPrMeta throws Invalid pr-meta.json on oversize", () => {
    const dir = mkdtempSync(join(tmpdir(), "prmeta-"));
    try {
      const m: PrMeta = {
        pr_number: 42,
        head_sha: "a".repeat(40),
        base_sha: "b".repeat(40),
        head_repo_full_name: "org/repo",
        is_fork: false,
      };
      writeFileSync(join(dir, "pr-meta.json"), JSON.stringify(m), "utf8");
      expect(() => readPrMeta(dir, 10)).toThrow(/Invalid pr-meta\.json/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("pr-meta verdicts (dedup)", () => {
  it("round-trips verdicts through pr-meta; unknown top-level keys stay lenient", async () => {
    const { writePrMeta, readPrMeta } = await import("../src/diff.js");
    const dir = mkdtempSync(join(tmpdir(), "prmeta-"));
    try {
      const m: PrMeta = {
        pr_number: 42,
        head_sha: "a".repeat(40),
        base_sha: "b".repeat(40),
        head_repo_full_name: "org/repo",
        is_fork: false,
        verdicts: { pairs: [[0, 1]], links: [[2, 0]], malformed: 1 },
      };
      writePrMeta(m, dir);
      expect(readPrMeta(dir)).toEqual(m);
      writeFileSync(join(dir, "pr-meta.json"), JSON.stringify({ ...m, fail_level: "none" }), "utf8");
      expect(readPrMeta(dir)).toEqual(m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined verdicts when the key is missing", async () => {
    const { writePrMeta, readPrMeta } = await import("../src/diff.js");
    const dir = mkdtempSync(join(tmpdir(), "prmeta-"));
    try {
      const m: PrMeta = {
        pr_number: 42,
        head_sha: "a".repeat(40),
        base_sha: "b".repeat(40),
        head_repo_full_name: "org/repo",
        is_fork: false,
      };
      writePrMeta(m, dir);
      expect(readPrMeta(dir)).toEqual(m);
      expect(readPrMeta(dir)!.verdicts).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ["non-object", "x"],
    ["null", null],
    ["array", []],
    ["pairs not an array", { pairs: "x", links: [], malformed: 0 }],
    ["links not an array", { pairs: [], links: {}, malformed: 0 }],
    ["malformed negative", { pairs: [], links: [], malformed: -1 }],
    ["malformed non-integer", { pairs: [], links: [], malformed: 1.5 }],
    ["malformed missing", { pairs: [], links: [] }],
    ["negative pair index", { pairs: [[0, -1]], links: [], malformed: 0 }],
    ["non-integer pair index", { pairs: [[0, 1.5]], links: [], malformed: 0 }],
    ["long pair", { pairs: [[0, 1, 2]], links: [], malformed: 0 }],
    ["non-integer link target", { pairs: [], links: [[2, "a"]], malformed: 0 }],
    ["negative link index", { pairs: [], links: [[-2, 0]], malformed: 0 }],
  ])("readPrMeta throws like any contract violation on malformed verdicts (%s)", async (_name, verdicts) => {
    const { readPrMeta } = await import("../src/diff.js");
    const dir = mkdtempSync(join(tmpdir(), "prmeta-"));
    try {
      writeFileSync(
        join(dir, "pr-meta.json"),
        JSON.stringify({
          pr_number: 42,
          head_sha: "a".repeat(40),
          base_sha: "b".repeat(40),
          head_repo_full_name: "org/repo",
          is_fork: false,
          verdicts,
        }),
        "utf8",
      );
      expect(() => readPrMeta(dir)).toThrow(/Invalid pr-meta\.json/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
