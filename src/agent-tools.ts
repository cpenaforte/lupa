import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { AGENT_LIMITS } from "./agent-types.js";
import type { ToolDef } from "./agent-types.js";

export interface ToolRoots {
  self: string;
  linked?: Map<string, string>;
}

export interface ToolContext {
  roots: ToolRoots;
  ensureLinked?: (alias: string) => Promise<{ dir: string } | { error: string }>;
}

const DRIVE_LETTER = /^[a-zA-Z]:/;
const TRUNCATION_MARKER = "\n[truncated]";

function splitSegments(p: string): string[] {
  return p.split(/[\\/]/);
}

function hasGitSegment(p: string): boolean {
  return splitSegments(p).some((s) => s.toLowerCase() === ".git");
}

/**
 * Realpath of `p` when it exists, otherwise of its nearest existing ancestor.
 * Catches an escaping symlinked directory even when the requested leaf does
 * not exist yet.
 */
function realpathExistingAncestor(p: string): string | null {
  let cur = p;
  for (;;) {
    try {
      return realpathSync(cur);
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return null;
      cur = parent;
    }
  }
}

/**
 * Resolve `rel` under `root`, returning the resolved path or null when the
 * path escapes the root. Rejects empty, absolute (POSIX or drive-letter),
 * any `..` segment, any `.git` segment (case-insensitive), and any symlink
 * whose realpath (or the realpath of its nearest existing ancestor) leaves
 * the root or lands under a `.git` segment. The realpath `.git` check is
 * load-bearing: a PR-committed symlink `evil -> .git` would otherwise pass
 * containment and expose the checkout credential.
 */
export function resolveWithinRoot(root: string, rel: string): string | null {
  if (!rel) return null;
  if (isAbsolute(rel) || DRIVE_LETTER.test(rel)) return null;
  const segments = splitSegments(rel);
  if (segments.some((s) => s === "..")) return null;
  if (segments.some((s) => s.toLowerCase() === ".git")) return null;

  const rootResolved = resolve(root);
  const resolved = resolve(rootResolved, rel);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + sep)) return null;

  try {
    const realRoot = realpathSync(rootResolved);
    const realTarget = realpathExistingAncestor(resolved);
    if (realTarget === null) return null;
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) return null;
    if (hasGitSegment(realTarget)) return null;
  } catch {
    // Root does not exist yet: no symlink can escape, so the lexical
    // containment above is the whole check.
  }
  return resolved;
}

function errorResult(message: string): { output: string; isError: boolean } {
  return { output: JSON.stringify({ error: message }), isError: true };
}

function okResult(payload: unknown): { output: string; isError: boolean } {
  return { output: JSON.stringify(payload), isError: false };
}

async function resolveRoot(repo: unknown, ctx: ToolContext): Promise<string | { error: string }> {
  const alias = repo === undefined || repo === null || repo === "" ? "self" : String(repo);
  if (alias === "self") return ctx.roots.self;
  const linked = ctx.roots.linked?.get(alias);
  if (linked) return linked;
  if (ctx.ensureLinked) {
    const res = await ctx.ensureLinked(alias);
    if ("dir" in res) return res.dir;
  }
  return { error: `repository not accessible: ${alias}` };
}

async function rootFor(args: Record<string, unknown>, ctx: ToolContext): Promise<{ root: string } | { error: string }> {
  const root = await resolveRoot(args.repo, ctx);
  if (typeof root === "string") return { root };
  return { error: root.error };
}

async function readFile(args: Record<string, unknown>, ctx: ToolContext): Promise<{ output: string; isError: boolean }> {
  const resolvedRoot = await rootFor(args, ctx);
  if ("error" in resolvedRoot) return errorResult(resolvedRoot.error);

  const rel = typeof args.path === "string" ? args.path : "";
  const target = resolveWithinRoot(resolvedRoot.root, rel);
  if (!target) return errorResult(`path not accessible: ${rel}`);

  let raw: string;
  try {
    raw = readFileSync(target, "utf8");
  } catch {
    return errorResult(`cannot read file: ${rel}`);
  }

  const lines = raw.split("\n");
  if (raw.endsWith("\n") && lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const total = lines.length;

  const start = args.start === undefined ? 1 : Number(args.start);
  const end = args.end === undefined ? total : Number(args.end);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < 1 || start > end) {
    return errorResult(`invalid line range: ${String(args.start)}..${String(args.end)}`);
  }

  const endLine = Math.min(end, total);
  const selected = start - 1 < total ? lines.slice(start - 1, endLine) : [];
  const actualEnd = selected.length ? start + selected.length - 1 : start - 1;
  const fullContent = selected.map((l, i) => `${start + i}: ${l}`).join("\n");

  const base = { path: rel, start_line: start, end_line: actualEnd, total_lines: total };
  const serialize = (content: string, truncated: boolean): string =>
    JSON.stringify({ ...base, truncated, content });

  if (Buffer.byteLength(serialize(fullContent, false), "utf8") <= AGENT_LIMITS.resultBytes) {
    return okResult(JSON.parse(serialize(fullContent, false)));
  }

  let lo = 0;
  let hi = fullContent.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = serialize(fullContent.slice(0, mid) + TRUNCATION_MARKER, true);
    if (Buffer.byteLength(candidate, "utf8") <= AGENT_LIMITS.resultBytes) lo = mid;
    else hi = mid - 1;
  }
  return okResult(JSON.parse(serialize(fullContent.slice(0, lo) + TRUNCATION_MARKER, true)));
}

interface DirEntry {
  name: string;
  type: "file" | "dir";
  size?: number;
}

async function listDir(args: Record<string, unknown>, ctx: ToolContext): Promise<{ output: string; isError: boolean }> {
  const resolvedRoot = await rootFor(args, ctx);
  if ("error" in resolvedRoot) return errorResult(resolvedRoot.error);

  const rel = typeof args.path === "string" && args.path !== "" ? args.path : ".";
  const target = resolveWithinRoot(resolvedRoot.root, rel);
  if (!target) return errorResult(`path not accessible: ${rel}`);

  let dirents;
  try {
    dirents = readdirSync(target, { withFileTypes: true });
  } catch {
    return errorResult(`cannot list directory: ${rel}`);
  }

  const entries: DirEntry[] = [];
  for (const d of dirents) {
    if (d.isDirectory()) {
      entries.push({ name: d.name, type: "dir" });
    } else if (d.isFile()) {
      let size: number | undefined;
      try {
        size = statSync(join(target, d.name)).size;
      } catch {
        size = undefined;
      }
      entries.push(size === undefined ? { name: d.name, type: "file" } : { name: d.name, type: "file", size });
    }
  }

  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  const cap = 200;
  const truncated = entries.length > cap;
  return okResult({ path: rel, entries: entries.slice(0, cap), truncated });
}

export const TOOL_DEFS: readonly ToolDef[] = [
  {
    name: "read_file",
    description:
      "Read a UTF-8 text file from the repository, returning numbered lines (1-based, inclusive range).",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repository-relative path of the file to read." },
        start: { type: "integer", description: "First line to include (1-based). Defaults to 1." },
        end: { type: "integer", description: "Last line to include (1-based, inclusive). Defaults to end of file." },
        repo: { type: "string", description: "Repository alias; omit or use \"self\" for the reviewed repository." },
      },
      required: ["path"],
    },
  },
  {
    name: "list_dir",
    description: "List a directory shallowly (name, type, size), directories first then files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repository-relative directory path. Defaults to the repository root." },
        repo: { type: "string", description: "Repository alias; omit or use \"self\" for the reviewed repository." },
      },
      required: ["path"],
    },
  },
  {
    name: "grep",
    description: "Search file contents with a JavaScript regular expression, returning matching lines.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "JavaScript regular expression (no flags)." },
        path: { type: "string", description: "Repository-relative path to search under. Defaults to the repository root." },
        glob: { type: "string", description: "Glob filter for file paths, e.g. \"src/**/*.ts\"." },
        max_results: { type: "integer", description: "Maximum number of matches to return (capped at 100)." },
        repo: { type: "string", description: "Repository alias; omit or use \"self\" for the reviewed repository." },
      },
      required: ["pattern"],
    },
  },
  {
    name: "glob",
    description: "List repository-relative paths matching a glob pattern.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern, e.g. \"src/**/*.ts\"." },
        repo: { type: "string", description: "Repository alias; omit or use \"self\" for the reviewed repository." },
      },
      required: ["pattern"],
    },
  },
];

export async function executeTool(
  name: string,
  args: unknown,
  ctx: ToolContext,
): Promise<{ output: string; isError: boolean }> {
  const a: Record<string, unknown> = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  try {
    switch (name) {
      case "read_file":
        return await readFile(a, ctx);
      case "list_dir":
        return await listDir(a, ctx);
      case "grep":
      case "glob":
        return errorResult("not implemented");
      default:
        return errorResult(`unknown tool: ${name}`);
    }
  } catch (e) {
    return errorResult(e instanceof Error ? e.message : String(e));
  }
}
