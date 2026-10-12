import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { byteCheck, oversizeMessage, readCappedFileSync, sourceForLabel } from "../src/artifact-limits.js";

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

  it("reads a full 64 KiB chunk boundary file with a large cap", () => {
    const dir = scratch();
    try {
      const p = join(dir, "chunk.json");
      writeFileSync(p, "y".repeat(65536), "utf8");
      expect(readCappedFileSync(p, 65536)).toEqual({ ok: true, text: "y".repeat(65536) });
      expect(readCappedFileSync(p, 100000)).toEqual({ ok: true, text: "y".repeat(65536) });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handles multi-chunk files: 65537 bytes passes a large cap, oversize at a 65536 cap", () => {
    const dir = scratch();
    try {
      const p = join(dir, "two-chunk.json");
      writeFileSync(p, "z".repeat(65537), "utf8");
      expect(readCappedFileSync(p, 100000)).toEqual({ ok: true, text: "z".repeat(65537) });
      expect(readCappedFileSync(p, 65536)).toEqual({ ok: false, oversize: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads a size-0-reporting source fully (/proc/self/cmdline, skipped when /proc is unavailable)", () => {
    const proc = "/proc/self/cmdline";
    if (!existsSync(proc)) return;
    const expected = readFileSync(proc, "utf8");
    expect(expected.length).toBeGreaterThan(0);
    expect(readCappedFileSync(proc, 1024 * 1024)).toEqual({ ok: true, text: expected });
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
        source: "semgrep",
      },
    ]);
  });

  it("oversize with a lockfile label keeps the full label in the message but maps the source", () => {
    expect(byteCheck("abcd", 3, "osv-scanner (package-lock.json)")).toEqual([
      {
        severity: "warning",
        file: "",
        rule: "scanner-failed",
        message: "osv-scanner (package-lock.json) output exceeds the artifact read limit (3 bytes); results dropped",
        source: "osv-scanner",
      },
    ]);
  });
});

describe("sourceForLabel", () => {
  it("is identity for paren-free labels", () => {
    expect(sourceForLabel("semgrep")).toBe("semgrep");
    expect(sourceForLabel("trivy")).toBe("trivy");
    expect(sourceForLabel("gitleaks")).toBe("gitleaks");
    expect(sourceForLabel("sbom")).toBe("sbom");
    expect(sourceForLabel("gofmt")).toBe("gofmt");
  });

  it("strips the lockfile suffix from osv-scanner labels", () => {
    expect(sourceForLabel("osv-scanner (package-lock.json)")).toBe("osv-scanner");
    expect(sourceForLabel("osv-scanner (a/b/Cargo.lock)")).toBe("osv-scanner");
  });
});
