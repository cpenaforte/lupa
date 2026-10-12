import { execFile } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Finding } from "./fastpath.js";

export interface L2Tool {
  name: string;
  cmd: string;
  args: string[];
}

/** Failure details of a check-only run. `undefined` failure in a SpawnResult means success. */
export interface ToolFailure {
  /** Numeric exit code, errno string (e.g. "ENOENT", "EACCES"), or null. */
  code: number | string | null;
  /** Terminating signal when killed (e.g. "SIGKILL"), else null. */
  signal: string | null;
  /** Combined stdout+stderr. */
  output: string;
  /** True when the per-tool timeout killed the process. */
  timedOut?: boolean;
}

/** Per-tool wall-clock budget for L2 toolchains (same budget as the scanners). */
export const L2_TIMEOUT_MS = 600_000;

/** Success stdout travels with the failure so interpreters can parse file lists. */
export interface SpawnResult {
  failure: ToolFailure | undefined;
  /** Raw stdout (never the combined output; `failure.output` still holds stdout+stderr). */
  stdout: string;
}

/** Injectable process runner. Tests stub it; production uses `execTool`. */
export type Spawner = (
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs?: number,
) => Promise<SpawnResult>;

const MAX_BUFFER = 16 * 1024 * 1024;

/** Regular files directly inside `dir` (directories and unreadable entries are excluded). */
function listFiles(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => {
    try {
      return statSync(join(dir, n)).isFile();
    } catch {
      return false;
    }
  });
}

/** `pyproject.toml` only counts as a ruff config when it declares a [tool.ruff] table or subtable. */
function pyprojectHasRuff(dir: string): boolean {
  try {
    return /^\s*\[tool\.ruff(\.[^\]]*)?\]/m.test(readFileSync(join(dir, "pyproject.toml"), "utf8"));
  } catch {
    return false;
  }
}

/**
 * Detect native linters by config-file presence. Returns tool names in a stable order.
 * Only regular files count; a directory named like a marker does not trigger.
 * - Cargo.toml → cargo-fmt, cargo-clippy
 * - package.json, .prettierrc*, prettier.config.* → prettier (config may live in package.json)
 * - .eslintrc*, eslint.config.* → eslint
 * - ruff.toml, or pyproject.toml containing [tool.ruff] (or any [tool.ruff.*]) → ruff
 * - go.mod → gofmt, go vet
 */
export function detectL2Tools(dir: string): string[] {
  const files = listFiles(dir);
  const has = (name: string) => files.includes(name);
  const hasPrefix = (prefix: string) => files.some((f) => f.startsWith(prefix));
  const out: string[] = [];

  if (has("Cargo.toml")) out.push("cargo-fmt", "cargo-clippy");
  if (has("package.json") || hasPrefix(".prettierrc") || hasPrefix("prettier.config.")) out.push("prettier");
  if (hasPrefix(".eslintrc") || hasPrefix("eslint.config.")) out.push("eslint");
  if (has("ruff.toml") || (has("pyproject.toml") && pyprojectHasRuff(dir))) out.push("ruff");
  if (has("go.mod")) out.push("gofmt", "go vet");

  return out;
}

/**
 * Check-only argv for an L2 tool. Never the mutating form (no `--write`, no `fmt` without `--check`).
 * `go vet` is split into cmd `go` + args, never executed as a single file name.
 */
export function l2Argv(name: string): { cmd: string; args: string[] } {
  switch (name) {
    case "cargo-fmt":
      return { cmd: "cargo", args: ["fmt", "--check"] };
    case "cargo-clippy":
      return { cmd: "cargo", args: ["clippy", "--", "-D", "warnings"] };
    case "prettier":
      return { cmd: "prettier", args: ["--check", "."] };
    case "eslint":
      return { cmd: "eslint", args: ["."] };
    case "ruff":
      return { cmd: "ruff", args: ["check", "."] };
    case "gofmt":
      return { cmd: "gofmt", args: ["-l", "."] };
    case "go vet":
      return { cmd: "go", args: ["vet", "./..."] };
    default:
      throw new Error(`unknown L2 tool: ${name}`);
  }
}

/**
 * Real runner: `execFile` with args array (no shell). Resolves `{ failure: undefined, stdout }`
 * on success (stdout captured, never discarded); on failure the combined output stays on
 * `failure.output` while raw stdout travels alongside for interpreters.
 * `timeoutMs` kills the tool when it outlives its budget; the failure is marked `timedOut`.
 */
export const execTool: Spawner = (cmd, args, cwd, timeoutMs = L2_TIMEOUT_MS) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd, maxBuffer: MAX_BUFFER, timeout: timeoutMs }, (err, stdout, stderr) => {
      const out = String(stdout);
      if (!err) return resolve({ failure: undefined, stdout: out });
      const e = err as NodeJS.ErrnoException & { signal?: NodeJS.Signals | null; killed?: boolean };
      const code = typeof e.code === "string" || typeof e.code === "number" ? e.code : null;
      resolve({
        failure: {
          code,
          signal: e.signal ?? null,
          output: `${out}${String(stderr)}`,
          timedOut: e.killed === true,
        },
        stdout: out,
      });
    });
  });

/** Human-readable failure reason: signal kill, errno (e.g. EACCES), or non-zero exit. */
function describeFailure(name: string, f: ToolFailure, timeoutMs: number): string {
  if (f.timedOut) return `${name} timed out after ${timeoutMs / 1000}s`;
  if (f.signal) return `${name} killed by signal ${f.signal}`;
  if (typeof f.code === "string") return `${name} could not run (${f.code})`;
  if (typeof f.code === "number") return `${name} reported issues (exit ${f.code})`;
  return `${name} exited abnormally`;
}

/** Per-tool interpreter: the spec's uniform signature (name, failure, stdout, changed). */
type Interpreter = (
  name: string,
  failure: ToolFailure | undefined,
  stdout: string,
  changed: Set<string>,
  timeoutMs: number,
) => Finding[];

/** Default interpreter (every tool but gofmt): byte-identical to the pre-F09 generic finding. */
function interpretDefault(
  name: string,
  failure: ToolFailure | undefined,
  _stdout: string,
  _changed: Set<string>,
  timeoutMs: number,
): Finding[] {
  if (!failure) return [];
  if (failure.code === "ENOENT") return [];
  const detail = failure.output.trim().split("\n").slice(0, 5).join("\n");
  return [
    {
      severity: "warning",
      file: "",
      rule: name,
      message: `${describeFailure(name, failure, timeoutMs)}${detail ? `:\n${detail}` : ""}`,
      source: name,
    },
  ];
}

/**
 * gofmt interpreter: `gofmt -l` lists unformatted files on stdout regardless of exit code,
 * so it is parsed on both paths and intersected with the PR's changed files. A timeout or
 * signal kill takes precedence over any partial file list and delegates to the default
 * interpreter, preserving today's timeout/signal warnings. When no files parse but a
 * failure is present, it delegates to the default interpreter so a nonzero exit
 * with an empty/unparseable file list still yields today's generic finding.
 */
export function interpretGofmt(
  name: string,
  failure: ToolFailure | undefined,
  stdout: string,
  changed: Set<string>,
  timeoutMs: number = L2_TIMEOUT_MS,
): Finding[] {
  if (failure?.timedOut === true || failure?.signal != null) {
    return interpretDefault(name, failure, stdout, changed, timeoutMs);
  }
  const files = stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => (line.startsWith("./") ? line.slice(2) : line))
    .filter((file) => changed.has(file));
  if (files.length > 0) {
    return files.map((file) => ({
      severity: "warning" as const,
      file,
      rule: "gofmt",
      message: `gofmt: ${file} is not formatted (run gofmt -w ${file})`,
      source: "gofmt",
      confidence: 90,
      evidence: { analyzer: "gofmt" },
    }));
  }
  if (failure) return interpretDefault(name, failure, stdout, changed, timeoutMs);
  return [];
}

/** Per-tool interpreter registry: gofmt parses its file list, every other tool uses the default. */
const interpreters: Record<string, Interpreter> = {
  gofmt: interpretGofmt,
};

/** Run one check-only command, dispatching by tool name. Silence ([]) when clean or the binary is missing (ENOENT). */
async function runOne(
  name: string,
  dir: string,
  spawn: Spawner,
  timeoutMs: number,
  changed: Set<string>,
): Promise<Finding[]> {
  const { cmd, args } = l2Argv(name);
  const { failure, stdout } = await spawn(cmd, args, dir, timeoutMs);
  // Binary not installed on this runner: skip silently.
  if (failure?.code === "ENOENT") return [];
  const interpret = interpreters[name] ?? interpretDefault;
  return interpret(name, failure, stdout, changed, timeoutMs);
}

/**
 * Run every detected L2 tool in `dir`, sequentially. Clean or missing binary → no finding.
 * Per-tool interpreters: gofmt reports one warning per changed unformatted file (parsed
 * from `gofmt -l` output, including exit-0 success); every other tool yields today's generic
 * warning on failure. ENOENT (missing binary) stays silent; timeout and signal-kill
 * semantics are unchanged (one warning finding per tool).
 * `spawn` is injectable for tests; defaults to the real `execTool`.
 * `changedFiles` scopes file-list output (gofmt) to the PR; omitted means an empty set
 * (silence, never a whole-repo dump).
 */
export async function runL2(
  dir: string,
  spawn: Spawner = execTool,
  timeoutMs: number = L2_TIMEOUT_MS,
  changedFiles: Set<string> = new Set(),
): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const name of detectL2Tools(dir)) {
    findings.push(...(await runOne(name, dir, spawn, timeoutMs, changedFiles)));
  }
  return findings;
}
