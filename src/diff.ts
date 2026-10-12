import { existsSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { readCappedFileSync } from "./artifact-limits.js";
import { DEFAULT_MAX_ARTIFACT_BYTES } from "./inputs.js";

export interface FileDiff {
  file: string;
  hunks: string;
  truncated: boolean;
  /** Decided by git (binary diff). Never guess from extension. */
  binary?: boolean;
  /** Bytes on disk (stat). The large-file rule uses this, never hunks.length. */
  size?: number;
}

/** One commentable diff line. LEFT = old-file line number (deletion); RIGHT = new-file line number. */
export interface HunkLine {
  side: "LEFT" | "RIGHT";
  line: number;
  kind: "add" | "del" | "ctx";
}

/** One unified-diff hunk of a file, with the commentable lines it exposes. */
export interface ParsedHunk {
  file: string;
  lines: HunkLine[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Parses unified-diff hunk text (as stored in FileDiff.hunks) into commentable lines.
 * `-` lines are LEFT (old numbering), `+` and context lines are RIGHT (new numbering).
 * Lines before the first `@@` and `\ No newline` markers are ignored. Blank lines are
 * skipped: real `git diff` output always prefixes context lines with a space.
 */
export function parseHunks(files: { file: string; hunks: string }[]): ParsedHunk[] {
  const out: ParsedHunk[] = [];
  for (const f of files) {
    let current: ParsedHunk | undefined;
    let oldLine = 0;
    let newLine = 0;
    for (const raw of f.hunks.split("\n")) {
      const header = HUNK_HEADER.exec(raw);
      if (header) {
        oldLine = Number(header[1]);
        newLine = Number(header[2]);
        current = { file: f.file, lines: [] };
        out.push(current);
        continue;
      }
      if (current === undefined || raw === "" || raw.startsWith("\\")) continue;
      const tag = raw[0];
      if (tag === "-") {
        current.lines.push({ side: "LEFT", line: oldLine, kind: "del" });
        oldLine++;
      } else if (tag === "+") {
        current.lines.push({ side: "RIGHT", line: newLine, kind: "add" });
        newLine++;
      } else if (tag === " ") {
        current.lines.push({ side: "RIGHT", line: newLine, kind: "ctx" });
        oldLine++;
        newLine++;
      }
    }
  }
  return out;
}

/** Lockfile basenames (any ecosystem). Prompt-filtered only. */
const LOCKFILES: ReadonlySet<string> = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "go.sum",
  "Gemfile.lock",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "composer.lock",
  "pubspec.lock",
  "Podfile.lock",
  "packages.lock.json",
  "gradle.lockfile",
  "flake.lock",
]);

/** True when the path's basename is a known lockfile (any ecosystem). */
export function isLockfile(path: string): boolean {
  return LOCKFILES.has(basename(path));
}

/**
 * PROMPT-LLM ONLY. Drops lockfiles, minified JS, source maps and binaries.
 * L0 must run on the UNFILTERED list first (binary note / lockfile-without-manifest).
 */
export function filterForPrompt(files: FileDiff[]): FileDiff[] {
  return files.filter((f) => {
    if (f.binary === true) return false;
    if (LOCKFILES.has(basename(f.file))) return false;
    if (f.file.endsWith(".min.js")) return false;
    if (f.file.endsWith(".map")) return false;
    return true;
  });
}

/**
 * Parses `git diff --name-status -R` (`R<score>\told\tnew`) and
 * `rename from` / `rename to` headers. Findings always use newPath.
 */
export function parseRename(nameStatus: string): { oldPath: string; newPath: string }[] {
  const out: { oldPath: string; newPath: string }[] = [];
  let pendingFrom: string | undefined;
  for (const line of nameStatus.split(/\r?\n/)) {
    const tab = /^R\d*\t([^\t]+)\t([^\t]+)$/.exec(line);
    if (tab) {
      out.push({ oldPath: tab[1], newPath: tab[2] });
      continue;
    }
    if (line.startsWith("rename from ")) {
      pendingFrom = line.slice("rename from ".length);
      continue;
    }
    if (line.startsWith("rename to ") && pendingFrom !== undefined) {
      out.push({ oldPath: pendingFrom, newPath: line.slice("rename to ".length) });
      pendingFrom = undefined;
    }
  }
  return out;
}

/** Per-file cap for the prompt diff (chars). Used by the orchestrator's truncateDiff call. */
export const PER_FILE_CAP = 8000;

const TRUNC_NOTE = "\n[... truncated ...]\n";

/**
 * Concatenates per-file sections, capping each at `perFile` chars and the
 * whole text at `maxChars`.
 *
 * Fill policy: greedy skip-and-continue. A section that does not fit the
 * remaining global budget is skipped (its path goes into `skipped`), but the
 * loop keeps going, so later smaller sections can still fill the budget.
 * Callers surface `skipped`; the prompt note about skipped files is added by
 * buildMessages (Task 8), not here.
 */
export function truncateDiff(
  files: FileDiff[],
  maxChars: number,
  perFile: number,
): { text: string; skipped: string[] } {
  const parts: string[] = [];
  const skipped: string[] = [];
  let total = 0;
  for (const f of files) {
    let section = `--- ${f.file}\n${f.hunks}\n`;
    if (section.length > perFile) {
      section = section.slice(0, Math.max(0, perFile - TRUNC_NOTE.length)) + TRUNC_NOTE;
    }
    if (total + section.length > maxChars) {
      skipped.push(f.file);
      continue;
    }
    parts.push(section);
    total += section.length;
  }
  return { text: parts.join(""), skipped };
}

export interface PrMeta {
  pr_number: number;
  head_sha: string;
  base_sha: string;
  head_repo_full_name: string;
  is_fork: boolean;
}

const PR_META_FILE = "pr-meta.json";

export function writePrMeta(m: PrMeta, dir: string): void {
  writeFileSync(join(dir, PR_META_FILE), JSON.stringify(m, null, 2) + "\n", "utf8");
}

/** Returns undefined when no pr-meta file exists; throws when it is malformed. */
export function readPrMeta(dir: string, maxBytes: number = DEFAULT_MAX_ARTIFACT_BYTES): PrMeta | undefined {
  const path = join(dir, PR_META_FILE);
  if (!existsSync(path)) return undefined;
  const capped = readCappedFileSync(path, maxBytes);
  if (!capped.ok) throw new Error(`Invalid ${PR_META_FILE} in ${dir}: exceeds the artifact read limit (${maxBytes} bytes)`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(capped.text);
  } catch {
    throw new Error(`Invalid ${PR_META_FILE} in ${dir}: malformed JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid ${PR_META_FILE} in ${dir}`);
  }
  const v = parsed as Record<string, unknown>;
  if (
    typeof v.pr_number !== "number" ||
    typeof v.head_sha !== "string" ||
    typeof v.base_sha !== "string" ||
    typeof v.head_repo_full_name !== "string" ||
    typeof v.is_fork !== "boolean" ||
    !Number.isInteger(v.pr_number) ||
    v.pr_number < 1 ||
    !/^[0-9a-f]{40}$/i.test(v.head_sha) ||
    !/^[0-9a-f]{40}$/i.test(v.base_sha)
  ) {
    throw new Error(`Invalid ${PR_META_FILE} in ${dir}`);
  }
  return {
    pr_number: v.pr_number,
    head_sha: v.head_sha,
    base_sha: v.base_sha,
    head_repo_full_name: v.head_repo_full_name,
    is_fork: v.is_fork,
  };
}
