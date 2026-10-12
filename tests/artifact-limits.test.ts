import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { byteCheck, oversizeMessage, readCappedFileSync } from "../src/artifact-limits.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "art-"));
}

describe("readCappedFileSync", () => {
  it("passes a file of exactly max bytes", () => {
    const dir = scratch();
    try {
      const p = join(dir, "exact.json");
      writeFileSync(p, "x".repeat(16), "utf8");
      expect(readCappedFileSync(p, 16)).toEqual({ ok: true, text: "x".repeat(16) });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports oversize for max+1 bytes without the text", () => {
    const dir = scratch();
    try {
      const p = join(dir, "over.json");
      writeFileSync(p, "x".repeat(17), "utf8");
      expect(readCappedFileSync(p, 16)).toEqual({ ok: false, oversize: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("missing file throws (never conflated with oversize)", () => {
    const dir = scratch();
    try {
      expect(() => readCappedFileSync(join(dir, "nope.json"), 16)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("oversizeMessage", () => {
  it("exact spec text", () => {
    expect(oversizeMessage("semgrep", 100)).toBe(
      "semgrep output exceeds the artifact read limit (100 bytes); results dropped",
    );
  });
});

describe("byteCheck", () => {
  it("fits -> undefined", () => {
    expect(byteCheck("abc", 3, "semgrep")).toBeUndefined();
  });

  it("oversize -> single warning", () => {
    expect(byteCheck("abcd", 3, "semgrep")).toEqual([
      {
        severity: "warning",
        file: "",
        rule: "scanner-failed",
        message: "semgrep output exceeds the artifact read limit (3 bytes); results dropped",
      },
    ]);
  });
});
