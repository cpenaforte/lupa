import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AGENT_LIMITS } from "../src/agent-types.js";
import {
  TOOL_DEFS,
  executeTool,
  grepInRoot,
  isBinaryFile,
  matchGlob,
  resolveWithinRoot,
  walkFiles,
  walkPaths,
} from "../src/agent-tools.js";
import type { ToolContext } from "../src/agent-tools.js";

const created: string[] = [];
function tempRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "lupa-agent-"));
  created.push(d);
  return d;
}
function ctxFor(self: string): ToolContext {
  return { roots: { self } };
}
afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

describe("resolveWithinRoot", () => {
  it("resolveWithinRoot rejects absolute, .., and any .git segment", () => {
    const root = tempRoot();
    for (const bad of ["", "/etc/passwd", "C:\\Windows", "../x", "a/../b", ".git/config", "a/.git/config", ".GIT/config", "a/.Git/config"]) {
      expect(resolveWithinRoot(root, bad), bad).toBeNull();
    }
    expect(resolveWithinRoot(root, "a/b.txt")).toBe(join(root, "a/b.txt"));
    expect(resolveWithinRoot(root, ".")).toBe(root);
  });

  it("resolveWithinRoot rejects a symlink pointing outside the root", () => {
    const root = tempRoot();
    symlinkSync("/etc/passwd", join(root, "out"));
    expect(resolveWithinRoot(root, "out")).toBeNull();
    expect(resolveWithinRoot(root, "out/x")).toBeNull();
  });

  it("resolveWithinRoot rejects a symlink into .git", () => {
    const root = tempRoot();
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "config"), "secret");
    symlinkSync(".git", join(root, "evil"));
    expect(resolveWithinRoot(root, "evil")).toBeNull();
    expect(resolveWithinRoot(root, "evil/config")).toBeNull();
  });
});

describe("read_file", () => {
  it("read_file returns numbered lines and metadata", async () => {
    const root = tempRoot();
    writeFileSync(join(root, "a.txt"), "line1\nline2\nline3\n");
    const r = await executeTool("read_file", { path: "a.txt" }, ctxFor(root));
    expect(r.isError).toBe(false);
    const parsed = JSON.parse(r.output);
    expect(parsed.path).toBe("a.txt");
    expect(parsed.total_lines).toBe(3);
    expect(parsed.start_line).toBe(1);
    expect(parsed.end_line).toBe(3);
    expect(parsed.truncated).toBe(false);
    expect(parsed.content).toContain("1: line1");
    expect(parsed.content).toContain("3: line3");
  });

  it("read_file truncates content at 32KB with truncated=true", async () => {
    const root = tempRoot();
    const line = "x".repeat(99);
    writeFileSync(join(root, "big.txt"), (line + "\n").repeat(400));
    const r = await executeTool("read_file", { path: "big.txt" }, ctxFor(root));
    expect(r.isError).toBe(false);
    expect(Buffer.byteLength(r.output, "utf8")).toBeLessThanOrEqual(AGENT_LIMITS.resultBytes + 256);
    const parsed = JSON.parse(r.output);
    expect(parsed.truncated).toBe(true);
    expect(parsed.content).toContain("[truncated]");
  });

  it("read_file truncation never splits a surrogate pair", async () => {
    const root = tempRoot();
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    for (const n of [16320, 16321, 16330, 16331, 16332, 16340, 20000]) {
      writeFileSync(join(root, "emoji.txt"), "😀".repeat(n));
      const r = await executeTool("read_file", { path: "emoji.txt" }, ctxFor(root));
      expect(r.isError, `n=${n}`).toBe(false);
      expect(Buffer.byteLength(r.output, "utf8"), `n=${n}`).toBeLessThanOrEqual(AGENT_LIMITS.resultBytes);
      const parsed = JSON.parse(r.output);
      expect(parsed.truncated, `n=${n}`).toBe(true);
      expect(lone.test(parsed.content), `n=${n} produced a lone surrogate`).toBe(false);
    }
  });

  it("read_file refuses files over 1 MiB with a size error", async () => {
    const root = tempRoot();
    writeFileSync(join(root, "huge.bin"), Buffer.alloc(1048576 + 1, 0x78));
    const r = await executeTool("read_file", { path: "huge.bin" }, ctxFor(root));
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.output).error).toBe(
      "file too large: huge.bin (1048577 bytes > 1048576 byte limit; use grep or glob to narrow it down)",
    );
  });

  it("read_file still reads a file of exactly 1 MiB (truncated output, no size error)", async () => {
    const root = tempRoot();
    writeFileSync(join(root, "edge.bin"), Buffer.alloc(1048576, 0x78));
    const r = await executeTool("read_file", { path: "edge.bin" }, ctxFor(root));
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.output).truncated).toBe(true);
  });

  it("read_file rejects an invalid range and .git paths with isError", async () => {
    const root = tempRoot();
    writeFileSync(join(root, "a.txt"), "line1\nline2\nline3\n");
    for (const args of [
      { path: "a.txt", start: 5, end: 2 },
      { path: "a.txt", start: 0 },
      { path: "a.txt", start: 1.5 },
      { path: ".git/config" },
      { path: "/etc/passwd" },
    ]) {
      const r = await executeTool("read_file", args, ctxFor(root));
      expect(r.isError, JSON.stringify(args)).toBe(true);
      expect(JSON.parse(r.output)).toHaveProperty("error");
    }
  });

  it("truncated read_file reports end_line of the last fully visible line", async () => {
    const line = "x".repeat(200);
    for (const start of [1, 50]) {
      const root = tempRoot();
      writeFileSync(join(root, "wide.txt"), (line + "\n").repeat(400));
      const r = await executeTool("read_file", { path: "wide.txt", start }, ctxFor(root));
      expect(r.isError, `start=${start}`).toBe(false);
      const parsed = JSON.parse(r.output);
      expect(parsed.truncated, `start=${start}`).toBe(true);
      expect(parsed.content, `start=${start}`).toContain("[truncated]");
      const N = (parsed.content.match(/^\d+: /gm) ?? []).length;
      expect(N, `start=${start}`).toBeGreaterThan(0);
      expect(parsed.end_line, `start=${start}`).toBe(start + N - 1);
    }
  });

  it("truncated read_file backs up to complete lines", async () => {
    const line = "x".repeat(200);
    const root = tempRoot();
    writeFileSync(join(root, "wide.txt"), (line + "\n").repeat(400));
    const r = await executeTool("read_file", { path: "wide.txt", start: 1 }, ctxFor(root));
    expect(r.isError).toBe(false);
    const parsed = JSON.parse(r.output);
    expect(parsed.truncated).toBe(true);
    const N = (parsed.content.match(/^\d+: /gm) ?? []).length;
    const segments = String(parsed.content).split("\n");
    expect(segments[segments.length - 1]).toBe("[truncated]");
    expect(segments[segments.length - 2]).toBe(`${N}: ${line}`);
    expect(parsed.end_line).toBe(1 + N - 1);
  });

  it("single over-budget line shows partial content with end_line start - 1", async () => {
    const root = tempRoot();
    writeFileSync(join(root, "two.txt"), `short\n${"x".repeat(40000)}\n`);
    const r = await executeTool("read_file", { path: "two.txt", start: 2 }, ctxFor(root));
    expect(r.isError).toBe(false);
    const parsed = JSON.parse(r.output);
    expect(parsed.truncated).toBe(true);
    expect(parsed.content.length).toBeGreaterThan(0);
    expect(parsed.content.startsWith("2: x")).toBe(true);
    expect(parsed.end_line).toBe(1);
  });
});

describe("list_dir", () => {
  it("list_dir sorts dirs first and caps at 200 entries", async () => {
    const root = tempRoot();
    mkdirSync(join(root, "zdir"));
    mkdirSync(join(root, "adir"));
    writeFileSync(join(root, "b.txt"), "bb");
    writeFileSync(join(root, "a.txt"), "a");
    for (let i = 0; i < 210; i++) writeFileSync(join(root, `f${String(i).padStart(3, "0")}.txt`), "x");
    const r = await executeTool("list_dir", { path: "." }, ctxFor(root));
    expect(r.isError).toBe(false);
    const parsed = JSON.parse(r.output);
    expect(parsed.truncated).toBe(true);
    expect(parsed.entries).toHaveLength(200);
    expect(parsed.entries[0]).toEqual({ name: "adir", type: "dir" });
    expect(parsed.entries[1]).toEqual({ name: "zdir", type: "dir" });
    expect(parsed.entries[2]).toEqual({ name: "a.txt", type: "file", size: 1 });
  });
});

describe("TOOL_DEFS", () => {
  it("TOOL_DEFS schemas use only the cross-provider subset", () => {
    const allowed = new Set(["type", "properties", "required", "items", "enum", "description"]);
    const walk = (node: unknown, where: string): void => {
      if (Array.isArray(node)) {
        node.forEach((n, i) => walk(n, `${where}[${i}]`));
        return;
      }
      if (node && typeof node === "object") {
        for (const [k, v] of Object.entries(node)) {
          if (k === "properties") {
            for (const [name, sub] of Object.entries(v as Record<string, unknown>)) {
              walk(sub, `${where}.properties.${name}`);
            }
            continue;
          }
          expect(allowed.has(k), `${where}.${k} not in cross-provider subset`).toBe(true);
          walk(v, `${where}.${k}`);
        }
      }
    };
    expect(TOOL_DEFS.map((t) => t.name).sort()).toEqual(["glob", "grep", "list_dir", "read_file"]);
    for (const def of TOOL_DEFS) {
      expect(typeof def.description).toBe("string");
      walk(def.parameters, def.name);
    }
  });

  it("tool descriptions name the prune set", async () => {
    const glob = TOOL_DEFS.find((t) => t.name === "glob")!;
    const grep = TOOL_DEFS.find((t) => t.name === "grep")!;
    expect(glob.description).toContain(
      " Skips dependency directories (node_modules, vendor, target, .venv, venv, __pycache__) and .git.",
    );
    expect(grep.description).toContain(
      " Skips dependency directories (node_modules, vendor, target, .venv, venv, __pycache__) and .git.",
    );
  });
});

describe("executeTool", () => {
  it("unknown tool and unknown repo alias return isError JSON", async () => {
    const root = tempRoot();
    writeFileSync(join(root, "a.txt"), "hi");

    const unknown = await executeTool("bogus", {}, ctxFor(root));
    expect(unknown.isError).toBe(true);
    expect(JSON.parse(unknown.output)).toEqual({ error: "unknown tool: bogus" });

    const alias = await executeTool("read_file", { path: "a.txt", repo: "foo/bar" }, ctxFor(root));
    expect(alias.isError).toBe(true);
    expect(JSON.parse(alias.output)).toEqual({ error: "repository not accessible: foo/bar" });
  });

  it("repo alias resolves from the linked map or ensureLinked", async () => {
    const self = tempRoot();
    const linked = tempRoot();
    writeFileSync(join(linked, "a.txt"), "linked");
    const viaMap = await executeTool("read_file", { path: "a.txt", repo: "o/r" }, { roots: { self, linked: new Map([["o/r", linked]]) } });
    expect(viaMap.isError).toBe(false);
    expect(JSON.parse(viaMap.output).content).toContain("linked");

    const lazy = tempRoot();
    writeFileSync(join(lazy, "b.txt"), "lazy");
    const viaEnsure = await executeTool("read_file", { path: "b.txt", repo: "o/lazy" }, {
      roots: { self },
      ensureLinked: async (alias) => (alias === "o/lazy" ? { dir: lazy, sha: "a".repeat(40) } : { error: "nope" }),
    });
    expect(viaEnsure.isError).toBe(false);
    expect(JSON.parse(viaEnsure.output).content).toContain("lazy");

    const failed = await executeTool("read_file", { path: "b.txt", repo: "o/missing" }, {
      roots: { self },
      ensureLinked: async () => ({ error: "clone failed" }),
    });
    expect(failed.isError).toBe(true);
    expect(JSON.parse(failed.output)).toEqual({ error: "repository not accessible: o/missing" });
  });
});

describe("matchGlob", () => {
  it("matchGlob handles *, **, **/ and ?", () => {
    expect(matchGlob("src/a.ts", "src/**/*.ts")).toBe(true);
    expect(matchGlob("src/x/y.ts", "src/**/*.ts")).toBe(true);
    expect(matchGlob("src/x/y/z.ts", "src/**/*.ts")).toBe(true);
    expect(matchGlob("other/a.ts", "src/**/*.ts")).toBe(false);

    expect(matchGlob("a.md", "*.md")).toBe(true);
    expect(matchGlob("a/b.md", "*.md")).toBe(false);

    expect(matchGlob("abc", "a?c")).toBe(true);
    expect(matchGlob("a/c", "a?c")).toBe(false);
    expect(matchGlob("ac", "a?c")).toBe(false);
  });

  it("matchGlob treats dots literally (no regex escaping semantics)", () => {
    expect(matchGlob("a.b", "a.b")).toBe(true);
    expect(matchGlob("axb", "a.b")).toBe(false);
    expect(matchGlob("a+b", "a+b")).toBe(true);
    expect(matchGlob("aab", "a+b")).toBe(false);
  });

  it("matchGlob stays fast on a pathological glob", () => {
    const glob = "*a".repeat(15) + "*b";
    const path = "a".repeat(2000);
    expect(matchGlob(path, glob)).toBe(false);
  });
});

describe("grep", () => {
  it("grep finds matches with file:line and skips .git and binaries", async () => {
    const root = tempRoot();
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub", "a.txt"), "hello world\nfoo\n");
    writeFileSync(join(root, "b.txt"), "hello again\n");
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "secret.txt"), "hello secret\n");
    writeFileSync(join(root, "bin.dat"), Buffer.from([0x68, 0x00, 0x69]));

    const r = await executeTool("grep", { pattern: "hello" }, ctxFor(root));
    expect(r.isError).toBe(false);
    const parsed = JSON.parse(r.output);
    expect(parsed.matches).toContainEqual({ file: "sub/a.txt", line: 1, text: "hello world" });
    expect(parsed.matches).toContainEqual({ file: "b.txt", line: 1, text: "hello again" });
    expect(parsed.matches.some((m: { file: string }) => m.file.includes(".git"))).toBe(false);
    expect(parsed.matches.some((m: { file: string }) => m.file === "bin.dat")).toBe(false);
    expect(parsed.files_scanned).toBeGreaterThan(0);
    expect(parsed.truncated).toBe(false);
  });

  it("grep respects max_results and reports truncation", async () => {
    const root = tempRoot();
    writeFileSync(join(root, "a.txt"), Array.from({ length: 10 }, (_, i) => `hit ${i}`).join("\n"));
    const r = await executeTool("grep", { pattern: "hit", max_results: 3 }, ctxFor(root));
    expect(r.isError).toBe(false);
    const parsed = JSON.parse(r.output);
    expect(parsed.matches).toHaveLength(3);
    expect(parsed.truncated).toBe(true);
  });

  it("grep with an invalid regex returns isError", async () => {
    const root = tempRoot();
    writeFileSync(join(root, "a.txt"), "x");
    const r = await executeTool("grep", { pattern: "(" }, ctxFor(root));
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.output)).toHaveProperty("error");
  });

  it("grep kills a catastrophic pattern within the timeout", async () => {
    const root = tempRoot();
    writeFileSync(join(root, "evil.txt"), "a".repeat(40000) + "b");
    const r = await grepInRoot(root, { pattern: "(a+)+$" }, 200);
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.output)).toEqual({ error: "grep timed out" });
  });

  it("a valid regex with an injection payload reaches the worker without executing", async () => {
    const root = tempRoot();
    const sentinel = join(root, "pwned.txt");
    writeFileSync(join(root, "a.txt"), "hello\n");
    // Valid regex that contains `');require(` and, were the pattern interpolated
    // into the worker source, would execute writeFileSync.
    const payload = `(x');require('fs').writeFileSync(${JSON.stringify(sentinel)},'pwned')`;
    const r = await grepInRoot(root, { pattern: payload }, 500);
    expect(existsSync(sentinel)).toBe(false);
    if (r.isError) {
      expect(JSON.parse(r.output)).toHaveProperty("error");
    } else {
      const parsed = JSON.parse(r.output);
      expect(parsed.matches).toEqual([]);
      // files_scanned > 0 proves the pattern reached and ran inside the worker.
      expect(parsed.files_scanned).toBeGreaterThan(0);
    }
  });
});

describe("glob", () => {
  it("glob lists root-relative paths, sorted and capped", async () => {
    const root = tempRoot();
    mkdirSync(join(root, "src", "x"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "");
    writeFileSync(join(root, "src", "x", "y.ts"), "");
    writeFileSync(join(root, "src", "b.md"), "");
    const r = await executeTool("glob", { pattern: "src/**/*.ts" }, ctxFor(root));
    expect(r.isError).toBe(false);
    const parsed = JSON.parse(r.output);
    expect(parsed.paths).toEqual(["src/a.ts", "src/x/y.ts"]);
    expect(parsed.truncated).toBe(false);
  });
});

describe("grep and glob symlinks", () => {
  it("grep and glob skip symlinked directories", async () => {
    const root = tempRoot();
    mkdirSync(join(root, "real"));
    writeFileSync(join(root, "real", "a.txt"), "target line");
    symlinkSync(join(root, "real"), join(root, "link"));

    const g = await executeTool("grep", { pattern: "target" }, ctxFor(root));
    expect(g.isError).toBe(false);
    expect(JSON.parse(g.output).matches.map((m: { file: string }) => m.file)).toEqual(["real/a.txt"]);

    const gl = await executeTool("glob", { pattern: "**/*.txt" }, ctxFor(root));
    expect(gl.isError).toBe(false);
    expect(JSON.parse(gl.output).paths).toEqual(["real/a.txt"]);
  });
});

describe("glob pure discovery", () => {
  it("glob lists oversized and binary files (pure path discovery)", async () => {
    const root = tempRoot();
    writeFileSync(join(root, "small.ts"), "export {};\n");
    writeFileSync(join(root, "big.ts"), "x".repeat(1024 * 1024 + 1));
    writeFileSync(join(root, "blob.dat"), Buffer.concat([Buffer.from("hello"), Buffer.from([0]), Buffer.from("world")]));
    const ctx = ctxFor(root);

    const ts = await executeTool("glob", { pattern: "**/*.ts" }, ctx);
    expect(ts.isError).toBe(false);
    const tsParsed = JSON.parse(ts.output);
    expect(tsParsed.paths).toContain("small.ts");
    expect(tsParsed.paths).toContain("big.ts");
    expect(tsParsed.truncated).toBe(false);

    const dat = await executeTool("glob", { pattern: "**/*.dat" }, ctx);
    expect(dat.isError).toBe(false);
    const datParsed = JSON.parse(dat.output);
    expect(datParsed.paths).toContain("blob.dat");
    expect(datParsed.truncated).toBe(false);
  });

  it("glob and grep prune vendor subtrees", async () => {
    const root = tempRoot();
    const w = (rel: string, content: string): void => {
      mkdirSync(join(root, dirname(rel)), { recursive: true });
      writeFileSync(join(root, rel), content);
    };
    w("src/keep.ts", "export function keepAlive() {}\n");
    w("src/dist/out.js", "nothing to see here\n");
    w("src/build/out.js", "nothing to see here\n");
    w("src/target", "nothing to see here\n");
    w("src/VENDOR/w.js", "nothing to see here\n");
    w("src/.GIT/z", "nothing to see here\n");
    w("src/nested/node_modules/y", "nothing to see here\n");
    w("node_modules/dep/evil.ts", "export const evil = 1;\n");
    w("node_modules/dep/evil.js", "nothing to see here\n");
    w("vendor/evil.ts", "export const evil = 1;\n");
    w("target/x", "nothing to see here\n");
    w(".venv/x", "nothing to see here\n");
    w("venv/x", "nothing to see here\n");
    w("__pycache__/x", "nothing to see here\n");
    const ctx = ctxFor(root);

    const ts = JSON.parse((await executeTool("glob", { pattern: "**/*.ts" }, ctx)).output);
    expect(ts.paths).toEqual(["src/keep.ts"]);

    const all = JSON.parse((await executeTool("glob", { pattern: "**/*" }, ctx)).output);
    expect(all.paths).toContain("src/keep.ts");
    expect(all.paths).toContain("src/target");
    expect(all.paths).toContain("src/VENDOR/w.js");
    for (const bad of [
      "node_modules/dep/evil.ts",
      "node_modules/dep/evil.js",
      "vendor/evil.ts",
      "target/x",
      ".venv/x",
      "venv/x",
      "__pycache__/x",
      "src/nested/node_modules/y",
      "src/.GIT/z",
    ]) {
      expect(all.paths, bad).not.toContain(bad);
    }

    const js = JSON.parse((await executeTool("glob", { pattern: "**/*.js" }, ctx)).output);
    expect(js.paths).toContain("src/dist/out.js");
    expect(js.paths).toContain("src/build/out.js");
    expect(js.paths).toContain("src/VENDOR/w.js");
    expect(js.paths).not.toContain("node_modules/dep/evil.js");

    const evil = JSON.parse((await executeTool("grep", { pattern: "evil", path: "vendor" }, ctx)).output);
    expect(evil.matches.map((m: { file: string }) => m.file)).toContain("vendor/evil.ts");

    const keep = JSON.parse((await executeTool("grep", { pattern: "keep" }, ctx)).output);
    expect(keep.matches.map((m: { file: string }) => m.file)).toContain("src/keep.ts");
    expect(keep.files_scanned).toBe(5);
    expect(keep.skipped).toEqual({ oversized: 0, binary: 0, overLimit: 0, pruned: 7 });
  });

  it("glob caps at 200 paths", async () => {
    const root = tempRoot();
    for (let i = 0; i < 205; i++) writeFileSync(join(root, `f${i}.txt`), "x\n");
    const r = await executeTool("glob", { pattern: "**/*" }, ctxFor(root));
    expect(r.isError).toBe(false);
    const parsed = JSON.parse(r.output);
    expect(parsed.paths).toHaveLength(200);
    expect(parsed.truncated).toBe(true);
  });
});

describe("grep skips and bounded walks", () => {
  it("grep reports eligibility skips explicitly", async () => {
    const root = tempRoot();
    writeFileSync(join(root, "ok.ts"), "marker here\n");
    writeFileSync(join(root, "big.ts"), "marker " + "x".repeat(1024 * 1024));
    writeFileSync(join(root, "blob.dat"), Buffer.concat([Buffer.from("marker"), Buffer.from([0, 1, 2]), Buffer.from("tail")]));
    const r = await executeTool("grep", { pattern: "marker" }, ctxFor(root));
    expect(r.isError).toBe(false);
    const parsed = JSON.parse(r.output);
    expect(parsed.skipped).toEqual({ oversized: 1, binary: 1, overLimit: 0, pruned: 0 });
    expect(parsed.files_scanned).toBe(1);
  });

  it("walk stops at maxFiles and reports overLimit", async () => {
    // Flat 30 files, maxFiles 10: exact file remainder through both walks.
    {
      const root = tempRoot();
      for (let i = 0; i < 30; i++) writeFileSync(join(root, `f${i}.txt`), "x\n");
      const wf = walkFiles(root, root, { maxFiles: 10 });
      expect(wf.files).toHaveLength(10);
      expect(wf.truncated).toBe(true);
      expect(wf.skipped.overLimit).toBe(20);
      const wp = walkPaths(root, root, { maxFiles: 10 });
      expect(wp.paths).toHaveLength(10);
      expect(wp.truncated).toBe(true);
      expect(wp.skipped.overLimit).toBe(20);
    }
    // Fire-case exclusion: pruned entries never counted in the remainder.
    {
      const root = tempRoot();
      for (let i = 0; i < 30; i++) writeFileSync(join(root, `f${i}.txt`), "x\n");
      mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
      for (let i = 0; i < 5; i++) writeFileSync(join(root, "node_modules", "dep", `e${i}.js`), "evil\n");
      const wf = walkFiles(root, root, { maxFiles: 10 });
      expect(wf.truncated).toBe(true);
      expect(wf.skipped.overLimit).toBe(20);
    }
    // Stacked check-(a): root holding only a/ and b/ (10 files each), maxFiles 1.
    {
      const root = tempRoot();
      for (const d of ["a", "b"]) {
        mkdirSync(join(root, d));
        for (let i = 0; i < 10; i++) writeFileSync(join(root, d, `f${i}.txt`), "x\n");
      }
      const wf = walkFiles(root, root, { maxFiles: 1 });
      expect(wf.truncated).toBe(true);
      expect(wf.skipped.overLimit).toBe(2);
      // walkPaths returns files only: directories are traversed, never listed.
      const wp = walkPaths(root, root);
      expect(wp.paths).toHaveLength(20);
      expect(wp.paths).not.toContain("a");
      expect(wp.paths).not.toContain("b");
    }
    // Exact fit: flat 30 files, maxFiles 30.
    {
      const root = tempRoot();
      for (let i = 0; i < 30; i++) writeFileSync(join(root, `f${i}.txt`), "x\n");
      const wf = walkFiles(root, root, { maxFiles: 30 });
      expect(wf.files).toHaveLength(30);
      expect(wf.truncated).toBe(false);
      expect(wf.skipped.overLimit).toBe(0);
    }
    // Pruned exclusion: node_modules (20 files) + src/ (5 files), maxFiles 6.
    {
      const root = tempRoot();
      mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
      for (let i = 0; i < 20; i++) writeFileSync(join(root, "node_modules", "dep", `e${i}.js`), "evil\n");
      mkdirSync(join(root, "src"));
      for (let i = 0; i < 5; i++) writeFileSync(join(root, "src", `f${i}.txt`), "x\n");
      const wf = walkFiles(root, root, { maxFiles: 6 });
      expect(wf.truncated).toBe(false);
      expect(wf.skipped.overLimit).toBe(0);
    }
    // Prune-filter-first: root holding ONLY node_modules/ (20 files), maxFiles 1.
    {
      const root = tempRoot();
      mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
      for (let i = 0; i < 20; i++) writeFileSync(join(root, "node_modules", "dep", `e${i}.js`), "evil\n");
      const wf = walkFiles(root, root, { maxFiles: 1 });
      expect(wf.truncated).toBe(false);
      expect(wf.skipped.overLimit).toBe(0);
    }
    // Remainder coverage: .git/ + symlink + src/ (2 files), maxFiles 3.
    {
      const root = tempRoot();
      mkdirSync(join(root, ".git"));
      writeFileSync(join(root, ".git", "secret.txt"), "secret\n");
      symlinkSync(join(root, "nonexistent"), join(root, "link"));
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "src", "a.txt"), "x\n");
      writeFileSync(join(root, "src", "b.txt"), "x\n");
      const wf = walkFiles(root, root, { maxFiles: 3 });
      expect(wf.truncated).toBe(false);
      expect(wf.skipped.overLimit).toBe(0);
    }
    // Trailing dir: root holding only an empty subdir.
    {
      const root = tempRoot();
      mkdirSync(join(root, "sub"));
      const zero = walkFiles(root, root, { maxFiles: 0 });
      expect(zero.truncated).toBe(true);
      expect(zero.skipped.overLimit).toBe(1);
      const one = walkFiles(root, root, { maxFiles: 1 });
      expect(one.truncated).toBe(true);
      expect(one.skipped.overLimit).toBe(1);
    }
    // Stacked dir: root holding only subdir/ with 20 files, maxFiles 1.
    {
      const root = tempRoot();
      mkdirSync(join(root, "sub"));
      for (let i = 0; i < 20; i++) writeFileSync(join(root, "sub", `f${i}.txt`), "x\n");
      const wf = walkFiles(root, root, { maxFiles: 1 });
      expect(wf.truncated).toBe(true);
      expect(wf.skipped.overLimit).toBe(1);
    }
    // Multi-stack: root holding only a/ and b/ (10 files each), maxFiles 2.
    {
      const root = tempRoot();
      for (const d of ["a", "b"]) {
        mkdirSync(join(root, d));
        for (let i = 0; i < 10; i++) writeFileSync(join(root, d, `f${i}.txt`), "x\n");
      }
      const wf = walkFiles(root, root, { maxFiles: 2 });
      expect(wf.truncated).toBe(true);
      expect(wf.skipped.overLimit).toBe(2);
    }
  });

  it("grepInRoot honors walk limits and an expired deadline", async () => {
    const root = tempRoot();
    for (let i = 0; i < 30; i++) writeFileSync(join(root, `f${i}.txt`), "x\n");

    const limited = await grepInRoot(root, { pattern: "x" }, 5000, { maxFiles: 5 });
    expect(limited.isError).toBe(false);
    const lp = JSON.parse(limited.output);
    expect(lp.truncated).toBe(true);
    expect(lp.files_scanned).toBe(5);

    const expired = await grepInRoot(root, { pattern: "x" }, 5000, { deadlineMs: 0 });
    expect(expired.isError).toBe(false);
    const ep = JSON.parse(expired.output);
    expect(ep.truncated).toBe(true);
    expect(ep.skipped.overLimit).toBe(1);

    const wp = walkPaths(root, root, { deadlineMs: 0 });
    expect(wp.truncated).toBe(true);
    expect(wp.skipped.overLimit).toBe(1);

    const empty = tempRoot();
    const zero = walkFiles(empty, empty, { maxFiles: 0 });
    expect(zero.truncated).toBe(true);
    expect(zero.skipped.overLimit).toBe(1);
    const one = walkFiles(empty, empty, { maxFiles: 1 });
    expect(one.truncated).toBe(false);
    expect(one.skipped.overLimit).toBe(0);
  });

  it("generous deadline never fires", async () => {
    const root = tempRoot();
    for (let i = 0; i < 30; i++) writeFileSync(join(root, `f${i}.txt`), "x\n");
    const r = await grepInRoot(root, { pattern: "x" }, 5000, { deadlineMs: 60000 });
    expect(r.isError).toBe(false);
    const parsed = JSON.parse(r.output);
    expect(parsed.truncated).toBe(false);
    expect(parsed.skipped.overLimit).toBe(0);
    expect(parsed.skipped.pruned).toBe(0);
  });

  it("single-file start paths count eligibility skips", async () => {
    const root = tempRoot();
    writeFileSync(join(root, "big.ts"), "x".repeat(1024 * 1024 + 1));
    writeFileSync(join(root, "blob.dat"), Buffer.concat([Buffer.from("abc"), Buffer.from([0]), Buffer.from("def")]));
    writeFileSync(join(root, "ok.ts"), "hello\n");

    const big = await grepInRoot(root, { pattern: "x", path: "big.ts" }, 5000);
    expect(big.isError).toBe(false);
    const bp = JSON.parse(big.output);
    expect(bp.matches).toEqual([]);
    expect(bp.files_scanned).toBe(0);
    expect(bp.skipped.oversized).toBe(1);

    const bin = await grepInRoot(root, { pattern: "b", path: "blob.dat" }, 5000);
    expect(bin.isError).toBe(false);
    expect(JSON.parse(bin.output).skipped.binary).toBe(1);

    const fileAbs = join(root, "ok.ts");
    const zp = walkPaths(root, fileAbs, { maxFiles: 0 });
    expect(zp.paths).toEqual([]);
    expect(zp.truncated).toBe(true);
    expect(zp.skipped.overLimit).toBe(1);
    const op = walkPaths(root, fileAbs, { maxFiles: 1 });
    expect(op.paths).toEqual(["ok.ts"]);
    expect(op.truncated).toBe(false);
    expect(op.skipped.overLimit).toBe(0);

    const over = walkFiles(root, join(root, "big.ts"), { maxFiles: 0 });
    expect(over.truncated).toBe(true);
    expect(over.skipped).toEqual({ oversized: 0, binary: 0, overLimit: 1, pruned: 0 });
  });

  it("isBinaryFile treats open failure as binary (unreadable fold)", async () => {
    const root = tempRoot();
    const text = join(root, "a.txt");
    writeFileSync(text, "hello\n");
    expect(isBinaryFile(text)).toBe(false);
    const bin = join(root, "b.dat");
    writeFileSync(bin, Buffer.from([0x68, 0x00, 0x69]));
    expect(isBinaryFile(bin)).toBe(true);
    expect(isBinaryFile("xx\0xx")).toBe(true);
  });
});

describe("F11 tool-layer deadlines and byte caps", () => {
  it("expired deadlineMs fails fast without walking or spawning", async () => {
    const root = tempRoot();
    writeFileSync(join(root, "a.txt"), "hello\n");
    const ctx = ctxFor(root);
    const g = await executeTool("grep", { pattern: "x" }, ctx, { deadlineMs: 1 });
    expect(g.isError).toBe(true);
    expect(JSON.parse(g.output)).toEqual({ error: "grep timed out" });
    const gl = await executeTool("glob", { pattern: "**/*" }, ctx, { deadlineMs: 1 });
    expect(gl.isError).toBe(true);
    expect(JSON.parse(gl.output)).toEqual({ error: "glob timed out" });
  });
  it("huge deadlineMs behaves exactly as today", async () => {
    const root = tempRoot();
    writeFileSync(join(root, "a.txt"), "keep me\n");
    const g = await executeTool("grep", { pattern: "keep" }, ctxFor(root), { deadlineMs: Date.now() + 3600000 });
    expect(JSON.parse(g.output).matches.length).toBeGreaterThan(0);
  });
  it("generous endMs preserves today's worker timeout; expired endMs never spawns", async () => {
    const root = tempRoot();
    writeFileSync(join(root, "a.txt"), "keep me\n");
    const ok = await grepInRoot(root, { pattern: "keep" }, 200, undefined, Date.now() + 3600000);
    expect(JSON.parse(ok.output).matches.length).toBeGreaterThan(0);
    const noSpawn = await grepInRoot(root, { pattern: "keep" }, 200, undefined, 1);
    expect(noSpawn.isError).toBe(true);
    expect(JSON.parse(noSpawn.output)).toEqual({ error: "grep timed out" });
  });
  it("per-tool maxResultBytes caps output with the marker inside", async () => {
    const root = tempRoot();
    writeFileSync(join(root, "big.txt"), "x\n".repeat(5000));
    const r = await executeTool("read_file", { path: "big.txt" }, ctxFor(root), { maxResultBytes: 500 });
    const p = JSON.parse(r.output);
    expect(Buffer.byteLength(r.output, "utf8")).toBeLessThanOrEqual(500);
    expect(p.truncated).toBe(true);
    expect(p.content).toContain("[truncated]");
  });
  it("errorResult messages are capped with the marker inside", async () => {
    const root = tempRoot();
    const r = await executeTool("read_file", { path: "a".repeat(5000) }, ctxFor(root));
    expect(r.isError).toBe(true);
    expect(Buffer.byteLength(r.output, "utf8")).toBeLessThanOrEqual(2000 + 100);
    expect(r.output).toContain("[truncated]");
  });
  it("list_dir and glob drop tail entries under a small cap", async () => {
    const root = tempRoot();
    for (let i = 0; i < 10; i++) writeFileSync(join(root, `f${i}.txt`), "x\n");
    const l = await executeTool("list_dir", { path: "." }, ctxFor(root), { maxResultBytes: 300 });
    const lp = JSON.parse(l.output);
    expect(lp.truncated).toBe(true);
    expect(lp.entries.length).toBeLessThan(10);
    expect(Buffer.byteLength(l.output, "utf8")).toBeLessThanOrEqual(300);
  });
  it("resolveRoot forwards the deadline to ensureLinked", async () => {
    const root = tempRoot();
    writeFileSync(join(root, "a.txt"), "hello\n");
    const seen: unknown[] = [];
    const ctx = { roots: { self: root }, ensureLinked: async (alias: string, opts?: { deadlineMs?: number }) => { seen.push(opts?.deadlineMs); return { error: "nope" }; } };
    await executeTool("read_file", { path: "a.txt", repo: "o/r" }, ctx, { deadlineMs: 123456789 });
    expect(seen).toEqual([123456789]);
  });
});
