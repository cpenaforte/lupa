import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_LIMITS } from "../src/agent-types.js";
import { TOOL_DEFS, executeTool, grepInRoot, matchGlob, resolveWithinRoot } from "../src/agent-tools.js";
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
      ensureLinked: async (alias) => (alias === "o/lazy" ? { dir: lazy } : { error: "nope" }),
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
