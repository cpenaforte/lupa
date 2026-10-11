import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_LIMITS } from "../src/agent-types.js";
import { TOOL_DEFS, executeTool, resolveWithinRoot } from "../src/agent-tools.js";
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
