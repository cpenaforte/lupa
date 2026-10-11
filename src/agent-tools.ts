import { closeSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Worker } from "node:worker_threads";
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
 * Cut `s` to at most `n` UTF-16 code units without splitting a surrogate
 * pair. If the cut index falls on a low surrogate, the preceding high
 * surrogate would be left unpaired, so drop the whole pair.
 */
function codePointSafeCut(s: string, n: number): string {
  if (n <= 0) return "";
  if (n >= s.length) return s;
  const code = s.charCodeAt(n);
  const cut = code >= 0xdc00 && code <= 0xdfff ? n - 1 : n;
  return s.slice(0, cut);
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
    const candidate = serialize(codePointSafeCut(fullContent, mid) + TRUNCATION_MARKER, true);
    if (Buffer.byteLength(candidate, "utf8") <= AGENT_LIMITS.resultBytes) lo = mid;
    else hi = mid - 1;
  }
  return okResult(JSON.parse(serialize(codePointSafeCut(fullContent, lo) + TRUNCATION_MARKER, true)));
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

export const GREP_TIMEOUT_MS = 5000;
const GREP_MAX_MATCHES = 100;
const GREP_MAX_FILE_BYTES = 1024 * 1024;
const GREP_NUL_SCAN_BYTES = 8192;
const GREP_LINE_CHARS = 200;
const GLOB_MAX_PATHS = 200;

/**
 * Classic wildcard match within a single path segment: `*` matches any run of
 * characters and `?` matches exactly one. Dynamic programming, so it cannot
 * backtrack catastrophically.
 */
function matchSegment(seg: string, pat: string): boolean {
  const n = seg.length;
  const m = pat.length;
  let prev = new Array<boolean>(m + 1).fill(false);
  prev[0] = true;
  for (let j = 1; j <= m; j++) if (pat[j - 1] === "*") prev[j] = prev[j - 1];
  for (let i = 1; i <= n; i++) {
    const cur = new Array<boolean>(m + 1).fill(false);
    for (let j = 1; j <= m; j++) {
      const pc = pat[j - 1];
      if (pc === "*") cur[j] = prev[j] || cur[j - 1];
      else if (pc === "?") cur[j] = prev[j - 1];
      else cur[j] = prev[j - 1] && seg[i - 1] === pc;
    }
    prev = cur;
  }
  return prev[m];
}

/**
 * Non-backtracking glob matcher. `path` and `glob` are split on `/`; a `**`
 * segment matches zero or more path segments, and within a segment `*` matches
 * any run of characters while `?` matches exactly one. Polynomial time, so a
 * model-authored glob cannot hang the job the way a regex could.
 */
export function matchGlob(path: string, glob: string): boolean {
  const pathSegs = path.split("/");
  const globSegs = glob.split("/");
  const n = pathSegs.length;
  const m = globSegs.length;
  let prev = new Array<boolean>(m + 1).fill(false);
  prev[0] = true;
  for (let j = 1; j <= m; j++) if (globSegs[j - 1] === "**") prev[j] = prev[j - 1];
  for (let i = 1; i <= n; i++) {
    const cur = new Array<boolean>(m + 1).fill(false);
    for (let j = 1; j <= m; j++) {
      const g = globSegs[j - 1];
      if (g === "**") cur[j] = cur[j - 1] || prev[j];
      else cur[j] = prev[j - 1] && matchSegment(pathSegs[i - 1], g);
    }
    prev = cur;
  }
  return prev[m];
}

interface WalkFile {
  abs: string;
  rel: string;
}

/** True when the first 8KB of `p` contain a NUL byte (or `p` cannot be read). */
function isBinaryFile(p: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(p, "r");
    const buf = Buffer.allocUnsafe(GREP_NUL_SCAN_BYTES);
    const n = readSync(fd, buf, 0, GREP_NUL_SCAN_BYTES, 0);
    for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
    return false;
  } catch {
    return true;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

function relPath(root: string, abs: string): string {
  return relative(root, abs).split(sep).join("/");
}

function includeFile(root: string, abs: string, size: number): WalkFile | null {
  if (size > GREP_MAX_FILE_BYTES) return null;
  if (isBinaryFile(abs)) return null;
  return { abs, rel: relPath(root, abs) };
}

/**
 * Collect candidate files under `startAbs` (a directory or a single file),
 * skipping `.git` segments, symlinks, files larger than 1MB, and files whose
 * first 8KB contain a NUL byte. Paths are reported relative to `root` with
 * forward slashes.
 */
function walkFiles(root: string, startAbs: string): WalkFile[] {
  let startStat;
  try {
    startStat = statSync(startAbs);
  } catch {
    return [];
  }

  if (startStat.isFile()) {
    const f = includeFile(root, startAbs, startStat.size);
    return f ? [f] : [];
  }
  if (!startStat.isDirectory()) return [];

  const files: WalkFile[] = [];
  const stack: string[] = [startAbs];
  while (stack.length) {
    const dir = stack.pop()!;
    let dirents;
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) {
      if (d.name.toLowerCase() === ".git") continue;
      if (d.isSymbolicLink()) continue;
      const childAbs = join(dir, d.name);
      if (d.isDirectory()) {
        stack.push(childAbs);
      } else if (d.isFile()) {
        let size: number;
        try {
          size = statSync(childAbs).size;
        } catch {
          continue;
        }
        const f = includeFile(root, childAbs, size);
        if (f) files.push(f);
      }
    }
  }
  return files;
}

interface GrepMatch {
  file: string;
  line: number;
  text: string;
}

// CONSTANT worker source. The model-authored pattern and the file list travel
// via workerData; the pattern is NEVER interpolated into this string (that
// would be remote code execution).
const GREP_WORKER_SRC = [
  'const { parentPort, workerData } = require("node:worker_threads");',
  'const { readFileSync } = require("node:fs");',
  "const { pattern, files, limit } = workerData;",
  "const re = new RegExp(pattern);",
  "const matches = [];",
  "let filesScanned = 0;",
  "let hitLimit = false;",
  "for (const f of files) {",
  "  filesScanned++;",
  "  let content;",
  '  try { content = readFileSync(f.abs, "utf8"); } catch { continue; }',
  '  const lines = content.split("\\n");',
  "  for (let i = 0; i < lines.length; i++) {",
  "    if (re.test(lines[i])) {",
  "      if (matches.length >= limit) { hitLimit = true; break; }",
  "      const t = lines[i].trim();",
  "      matches.push({ file: f.rel, line: i + 1, text: t });",
  "    }",
  "  }",
  "  if (hitLimit) break;",
  "}",
  "parentPort.postMessage({ matches, filesScanned, hitLimit });",
].join("\n");

type GrepWorkerResult =
  | { isError: true; output: string }
  | { isError: false; matches: GrepMatch[]; filesScanned: number; hitLimit: boolean };

function runGrepWorker(pattern: string, files: WalkFile[], limit: number, timeoutMs: number): Promise<GrepWorkerResult> {
  return new Promise((resolvePromise) => {
    let worker: Worker;
    try {
      worker = new Worker(GREP_WORKER_SRC, {
        eval: true,
        workerData: { pattern, files: files.map((f) => ({ abs: f.abs, rel: f.rel })), limit },
      });
    } catch (e) {
      resolvePromise({ isError: true, output: errorResult(e instanceof Error ? e.message : String(e)).output });
      return;
    }

    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (result: GrepWorkerResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolvePromise(result);
    };
    timer = setTimeout(() => finish({ isError: true, output: errorResult("grep timed out").output }), timeoutMs);

    worker.on("message", (msg: { matches: GrepMatch[]; filesScanned: number; hitLimit: boolean }) => {
      finish({ isError: false, matches: msg.matches, filesScanned: msg.filesScanned, hitLimit: msg.hitLimit });
    });
    worker.on("error", (err: unknown) => {
      finish({ isError: true, output: errorResult(err instanceof Error ? err.message : String(err)).output });
    });
  });
}

/**
 * Search `root` (or the directory/file `args.path` resolves to within it) for
 * `args.pattern`, returning matching lines. The match itself runs in a
 * worker thread with a hard timeout so a catastrophic model-authored regex is
 * terminated instead of hanging the job.
 */
export async function grepInRoot(
  root: string,
  args: { pattern: string; path?: string; glob?: string; max_results?: number },
  timeoutMs: number = GREP_TIMEOUT_MS,
): Promise<{ output: string; isError: boolean }> {
  const pattern = typeof args.pattern === "string" ? args.pattern : "";
  try {
    new RegExp(pattern);
  } catch {
    return errorResult(`invalid regex: ${pattern}`);
  }

  const rel = args.path && args.path !== "" ? args.path : ".";
  const startAbs = resolveWithinRoot(root, rel);
  if (!startAbs) return errorResult(`path not accessible: ${rel}`);

  let files = walkFiles(root, startAbs);
  if (args.glob) files = files.filter((f) => matchGlob(f.rel, args.glob!));

  const requested = args.max_results === undefined ? GREP_MAX_MATCHES : Math.floor(Number(args.max_results));
  const limit = Number.isFinite(requested) ? Math.max(0, Math.min(requested, GREP_MAX_MATCHES)) : GREP_MAX_MATCHES;

  const outcome = await runGrepWorker(pattern, files, limit, timeoutMs);
  if (outcome.isError) return { output: outcome.output, isError: true };

  const { matches, filesScanned, hitLimit } = outcome;
  const capped: GrepMatch[] = matches.map((m) => ({
    file: m.file,
    line: m.line,
    text: codePointSafeCut(m.text, GREP_LINE_CHARS),
  }));
  const serialize = (list: GrepMatch[], truncated: boolean): string =>
    JSON.stringify({ matches: list, truncated, files_scanned: filesScanned });

  let lo = 0;
  let hi = capped.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(serialize(capped.slice(0, mid), true), "utf8") <= AGENT_LIMITS.resultBytes) lo = mid;
    else hi = mid - 1;
  }
  const truncated = hitLimit || lo < capped.length;
  return okResult(JSON.parse(serialize(capped.slice(0, lo), truncated)));
}

async function grep(args: Record<string, unknown>, ctx: ToolContext): Promise<{ output: string; isError: boolean }> {
  const resolvedRoot = await rootFor(args, ctx);
  if ("error" in resolvedRoot) return errorResult(resolvedRoot.error);
  return grepInRoot(resolvedRoot.root, {
    pattern: typeof args.pattern === "string" ? args.pattern : "",
    path: typeof args.path === "string" ? args.path : undefined,
    glob: typeof args.glob === "string" ? args.glob : undefined,
    max_results: args.max_results === undefined ? undefined : Number(args.max_results),
  });
}

async function glob(args: Record<string, unknown>, ctx: ToolContext): Promise<{ output: string; isError: boolean }> {
  const resolvedRoot = await rootFor(args, ctx);
  if ("error" in resolvedRoot) return errorResult(resolvedRoot.error);

  const pattern = typeof args.pattern === "string" ? args.pattern : "";
  const paths = walkFiles(resolvedRoot.root, resolvedRoot.root)
    .map((f) => f.rel)
    .filter((p) => matchGlob(p, pattern))
    .sort();

  const truncated = paths.length > GLOB_MAX_PATHS;
  return okResult({ paths: paths.slice(0, GLOB_MAX_PATHS), truncated });
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
        return await grep(a, ctx);
      case "glob":
        return await glob(a, ctx);
      default:
        return errorResult(`unknown tool: ${name}`);
    }
  } catch (e) {
    return errorResult(e instanceof Error ? e.message : String(e));
  }
}
