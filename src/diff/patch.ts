import { statSync } from "node:fs";
import { basename, join } from "node:path";
import type { FileDiff, ParsedHunk } from "../domain/diff.js";

function sizeOf(workDir: string | undefined, file: string): number {
  if (workDir === undefined) return 0;
  try {
    return statSync(join(workDir, file)).size;
  } catch {
    return 0;
  }
}

/**
 * Decodes a git C-style quoted path (`"caf\303\251.txt"`). Unquoted input is returned as-is.
 * `core.quotePath=false` avoids most quoting; this covers residual quoted names defensively.
 */
export function unquoteGitPath(s: string): string {
  if (s.length < 2 || !s.startsWith('"') || !s.endsWith('"')) return s;
  const body = s.slice(1, -1);
  const simple: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '"': 34, "\\": 92 };
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== "\\") {
      bytes.push(...Buffer.from(c, "utf8"));
      continue;
    }
    const octal = body.slice(i + 1, i + 4);
    if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(parseInt(octal, 8));
      i += 3;
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) break;
    bytes.push(simple[next] ?? Buffer.from(next, "utf8")[0]);
    i += 1;
  }
  return Buffer.from(bytes).toString("utf8");
}

/** The b-side path of a `diff --git` header, or undefined when the header is not recognized. */
function headerFile(line: string): string | undefined {
  const quoted = /^diff --git ("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/.exec(line);
  if (quoted) {
    const b = unquoteGitPath(quoted[2]);
    return b.startsWith("b/") ? b.slice(2) : undefined;
  }
  const plain = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
  return plain ? plain[2] : undefined;
}

/**
 * Splits `git diff -U3` output into per-file sections. `hunks` starts at the first `@@`, so
 * file headers never reach the hunk parsers. Binary sections are flagged from git's own text,
 * and deleted-file sections from the `deleted file mode` header.
 */
export function parseDiffFiles(text: string, workDir?: string): FileDiff[] {
  type Section = { file: string; lines: string[]; binary: boolean; deleted: boolean };
  const sections: Section[] = [];
  let cur: Section | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const file = headerFile(line);
      cur = file === undefined ? undefined : { file, lines: [], binary: false, deleted: false };
      if (cur !== undefined) sections.push(cur);
      continue;
    }
    if (cur === undefined) continue;
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) cur.binary = true;
    if (line.startsWith("deleted file mode")) cur.deleted = true;
    cur.lines.push(line);
  }
  return sections.map((s) => {
    const at = s.lines.findIndex((l) => l.startsWith("@@"));
    const hunks = at === -1 ? "" : s.lines.slice(at).join("\n").replace(/\n+$/, "");
    // Real on-disk size, so the large-file rule fires for binaries over 500 KB. A hunk-less text entry
    // (mode-only change) reports 0: L0 would otherwise read it as a binary-note.
    const size = hunks === "" && !s.binary ? 0 : sizeOf(workDir, s.file);
    const f: FileDiff = { file: s.file, hunks, truncated: false, size };
    if (s.binary) f.binary = true;
    if (s.deleted) f.deleted = true;
    return f;
  });
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
