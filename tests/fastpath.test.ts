import { describe, it, expect } from "vitest";
import { runL0 } from "../src/fastpath.js";
import { isLockfile } from "../src/diff.js";

describe("isLockfile", () => {
  it("matches known lockfile basenames in any directory", () => {
    expect(isLockfile("package-lock.json")).toBe(true);
    expect(isLockfile("apps/web/Cargo.lock")).toBe(true);
    expect(isLockfile("go.sum")).toBe(true);
  });

  it("rejects manifests and unrelated files", () => {
    expect(isLockfile("package.json")).toBe(false);
    expect(isLockfile("src/lockfile.ts")).toBe(false);
    expect(isLockfile("Cargo.toml")).toBe(false);
  });
});

describe("runL0", () => {
  it("flags pem, todos, lockfile-without-manifest (per-ecosystem)", () => {
    const noManifest = () => false;
    const f = runL0(
      [
        { file: "id_rsa", hunks: "key", truncated: false },
        { file: "a.ts", hunks: "// TODO fix", truncated: false },
        { file: "package-lock.json", hunks: "{}", truncated: false },
      ],
      { hasManifestFor: noManifest },
    );
    expect(f.some((x) => x.rule === "sensitive-path" && x.severity === "high")).toBe(true);
    expect(f.some((x) => x.rule === "todo-marker")).toBe(true);
    expect(f.some((x) => x.rule === "lockfile-without-manifest")).toBe(true);
    const mixed = runL0([{ file: "Cargo.lock", hunks: "", truncated: false }], {
      hasManifestFor: (l) => l === "package-lock.json",
    });
    expect(mixed.some((x) => x.rule === "lockfile-without-manifest")).toBe(true);
    const ok = runL0([{ file: "package-lock.json", hunks: "{}", truncated: false }], { hasManifestFor: () => true });
    expect(ok.some((x) => x.rule === "lockfile-without-manifest")).toBe(false);
  });

  it("binary-only input yields binary note (size-based) and large file warns", () => {
    const f = runL0([{ file: "img.png", hunks: "", truncated: false, size: 1024 }]);
    expect(f.some((x) => x.rule === "binary-note")).toBe(true);
    const big = runL0([{ file: "vid.mp4", hunks: "", truncated: false, size: 600 * 1024 }]);
    expect(big.some((x) => x.rule === "large-file" && x.severity === "warning")).toBe(true);
  });

  it("binary note fires on binary===true even with hunks present", () => {
    const f = runL0([{ file: "img.png", hunks: "Binary files differ", truncated: false, binary: true }]);
    expect(f.some((x) => x.rule === "binary-note")).toBe(true);
  });

  it("no binary note for an empty file with no size (empty hunks, size 0/undefined)", () => {
    const none = runL0([{ file: "empty.txt", hunks: "", truncated: false }]);
    expect(none.some((x) => x.rule === "binary-note")).toBe(false);
    const zero = runL0([{ file: "empty.txt", hunks: "", truncated: false, size: 0 }]);
    expect(zero.some((x) => x.rule === "binary-note")).toBe(false);
  });

  it("large-file uses size, never hunks.length", () => {
    const hugeHunks = "x".repeat(600 * 1024);
    const f = runL0([{ file: "a.ts", hunks: hugeHunks, truncated: false, size: 10 }]);
    expect(f.some((x) => x.rule === "large-file")).toBe(false);
  });

  it("no lockfile-without-manifest when the callback is omitted but no lockfile is present", () => {
    const f = runL0([{ file: "a.ts", hunks: "", truncated: false }]);
    expect(f.some((x) => x.rule === "lockfile-without-manifest")).toBe(false);
  });

  it("omitted hasManifestFor treats lockfiles as lacking a manifest (conservative)", () => {
    const f = runL0([{ file: "package-lock.json", hunks: "{}", truncated: false }]);
    expect(f.some((x) => x.rule === "lockfile-without-manifest" && x.severity === "warning")).toBe(true);
  });

  it("sensitive-path covers .env, .env.* and .pem but not unrelated names", () => {
    const f = runL0([
      { file: "config/.env", hunks: "", truncated: false },
      { file: "deploy/.env.production", hunks: "", truncated: false },
      { file: "certs/server.pem", hunks: "", truncated: false },
    ]);
    expect(f.filter((x) => x.rule === "sensitive-path" && x.severity === "high")).toHaveLength(3);
    const clean = runL0([{ file: "src/environment.ts", hunks: "", truncated: false }]);
    expect(clean.some((x) => x.rule === "sensitive-path")).toBe(false);
  });

  it("env templates (.env.example, .env.sample, .env.template) are not sensitive; .env.local still is", () => {
    const templates = runL0([
      { file: "config/.env.example", hunks: "", truncated: false },
      { file: ".env.sample", hunks: "", truncated: false },
      { file: "deploy/.env.template", hunks: "", truncated: false },
    ]);
    expect(templates.some((x) => x.rule === "sensitive-path")).toBe(false);
    const local = runL0([{ file: "config/.env.local", hunks: "", truncated: false }]);
    expect(local.some((x) => x.rule === "sensitive-path" && x.severity === "high")).toBe(true);
  });

  it("todo-marker reports the line number of the marker (headerless input counts from 1)", () => {
    const f = runL0([{ file: "a.ts", hunks: "const a = 1;\n// FIXME later\n", truncated: false }]);
    const t = f.find((x) => x.rule === "todo-marker");
    expect(t?.severity).toBe("info");
    expect(t?.file).toBe("a.ts");
    expect(t?.line).toBe(2);
  });

  describe("todo-marker real new-file line numbers", () => {
    const todoLines = (hunks: string) =>
      runL0([{ file: "a.ts", hunks, truncated: false }])
        .filter((x) => x.rule === "todo-marker")
        .map((x) => x.line);

    it("uses the new-file start from the @@ header and counts added lines", () => {
      const hunks = ["@@ -10,2 +40,3 @@", " const a = 1;", "+// TODO wire this", " const b = 2;"].join("\n");
      expect(todoLines(hunks)).toEqual([41]);
    });

    it("reports a TODO on a context line at its new-file line number", () => {
      const hunks = ["@@ -5,3 +7,3 @@", " keep", " // FIXME ctx", "+added"].join("\n");
      expect(todoLines(hunks)).toEqual([8]);
    });

    it("skips TODO on removed lines entirely (no finding)", () => {
      const hunks = ["@@ -1,2 +1,1 @@", "-// TODO gone", " kept"].join("\n");
      expect(todoLines(hunks)).toEqual([]);
    });

    it("removed lines do not advance the new-file counter", () => {
      const hunks = ["@@ -1,3 +1,2 @@", "-old one", "-old two", "+// XXX new"].join("\n");
      expect(todoLines(hunks)).toEqual([1]);
    });

    it("applies per-hunk offsets across multiple hunks", () => {
      const hunks = [
        "@@ -1,2 +1,2 @@",
        " a",
        "+// TODO first",
        "@@ -50,2 +100,3 @@",
        " b",
        "+// FIXME second",
        " c",
      ].join("\n");
      expect(todoLines(hunks)).toEqual([2, 101]);
    });

    it("hunk header without explicit counts still parses", () => {
      const hunks = ["@@ -3 +9 @@", "+// TODO single"].join("\n");
      expect(todoLines(hunks)).toEqual([9]);
    });
  });
});

describe("runL0 provenance (Q04)", () => {
  it("every L0 finding carries source fastpath and confidence 50", () => {
    const f = runL0(
      [
        { file: "id_rsa", hunks: "key", truncated: false },
        { file: "big.bin", hunks: "", truncated: false, size: 600 * 1024 },
        { file: "img.png", hunks: "", truncated: false, size: 1024 },
        { file: "package-lock.json", hunks: "{}", truncated: false },
        { file: "a.ts", hunks: "// TODO fix", truncated: false },
      ],
      { hasManifestFor: () => false },
    );
    expect(f.length).toBeGreaterThan(0);
    for (const x of f) {
      expect(x.source).toBe("fastpath");
      expect(x.confidence).toBe(50);
      expect(x.evidence).toBeUndefined();
    }
  });
});
