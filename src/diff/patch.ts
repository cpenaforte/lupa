import { statSync } from "node:fs";
import { basename, join } from "node:path";
import type { FileDiff, ParsedHunk, ParsedPatch, PatchIssue } from "../domain/diff.js";
export type { ParsedPatch, PatchIssue } from "../domain/diff.js";

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
function decodeGitPath(s: string): string | undefined {
  if (!s.startsWith('"')) return s !== "" && !/["\x00\t\r\n]/.test(s) ? s : undefined;
  if (!/^"(?:[^"\\]|\\.)*"$/.test(s)) return undefined;
  const body = s.slice(1, -1);
  const simple: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '"': 34, "\\": 92 };
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = String.fromCodePoint(body.codePointAt(i)!);
    if (c !== "\\") {
      bytes.push(...Buffer.from(c, "utf8"));
      i += c.length - 1;
      continue;
    }
    const octal = body.slice(i + 1, i + 4);
    if (/^[0-7]{3}$/.test(octal)) {
      const byte = parseInt(octal, 8);
      if (byte > 255) return undefined;
      bytes.push(byte);
      i += 3;
      continue;
    }
    const next = body[i + 1];
    if (next === undefined || simple[next] === undefined) return undefined;
    bytes.push(simple[next]);
    i += 1;
  }
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(bytes));
    return decoded !== "" && !decoded.includes("\0") ? decoded : undefined;
  } catch {
    return undefined;
  }
}

export function unquoteGitPath(s: string): string {
  return s.startsWith('"') ? decodeGitPath(s) ?? s : s;
}

type Paths = { old: string | null; current: string | null };

function prefixedPath(text: string, prefix: "a/" | "b/"): string | null | undefined {
  // Git terminates unquoted ---/+++ paths containing spaces with a tab.
  const path = decodeGitPath(text.endsWith("\t") ? text.slice(0, -1) : text);
  if (path === "/dev/null") return null;
  return path?.startsWith(prefix) && path.length > 2 ? path.slice(2) : undefined;
}

/** Enumerate possible separators instead of greedily choosing one in an unquoted path. */
function headerPaths(header: string): Paths[] {
  const body = header.slice("diff --git ".length);
  const paths: Paths[] = [];
  for (let at = body.indexOf(" "); at !== -1; at = body.indexOf(" ", at + 1)) {
    const old = prefixedPath(body.slice(0, at), "a/");
    const current = prefixedPath(body.slice(at + 1), "b/");
    if (typeof old === "string" && typeof current === "string") paths.push({ old, current });
  }
  return paths;
}

/** Read whole sections: only pre-hunk metadata can establish identity or section flags. */
export function parsePatch(text: string, workDir?: string): ParsedPatch {
  const result: ParsedPatch = { files: [], issues: [] };
  const sections: { header: string; lines: string[] }[] = [];
  let cur: (typeof sections)[number] | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      cur = { header: line, lines: [] };
      sections.push(cur);
      continue;
    }
    cur?.lines.push(line);
  }
  sections.forEach((s, index) => {
    const issue = (code: PatchIssue["code"]) => result.issues.push({
      section: index + 1, code,
      message: code === "ambiguous-path" ? "Patch section has no unambiguous file identity." : "Patch section has invalid or incomplete path metadata.",
    });
    const at = s.lines.findIndex((l) => l.startsWith("@@"));
    const metadata = at === -1 ? s.lines : s.lines.slice(0, at);
    const binary = metadata.some((l) => l.startsWith("Binary files ") || l === "GIT binary patch");
    const deleted = metadata.some((l) => l.startsWith("deleted file mode "));
    const values = (prefix: string) => metadata.filter((l) => l.startsWith(prefix)).map((l) => l.slice(prefix.length));
    const before = values("--- "), after = values("+++ ");
    const from = values("rename from "), to = values("rename to ");
    let paths: Paths | undefined;
    if (before.length || after.length) {
      if (before.length !== 1 || after.length !== 1) { issue("malformed-section"); return; }
      const old = prefixedPath(before[0], "a/"), current = prefixedPath(after[0], "b/");
      if (old === undefined || current === undefined || (old === null && current === null)) { issue("malformed-section"); return; }
      paths = { old, current };
    }
    if (from.length || to.length) {
      if (from.length !== 1 || to.length !== 1) { issue("malformed-section"); return; }
      const old = decodeGitPath(from[0]), current = decodeGitPath(to[0]);
      if (old === undefined || current === undefined || (paths && (paths.old !== old || paths.current !== current))) { issue("malformed-section"); return; }
      paths = { old, current };
    }
    if (paths === undefined) {
      const options = headerPaths(s.header);
      let candidates = options;
      // Mode-only changes cannot rename. For binary changes the same-path header also
      // identifies an unchanged name; a real rename has authoritative rename metadata.
      if (candidates.length > 1 && (binary || metadata.some((l) => l.startsWith("old mode ")))) {
        candidates = candidates.filter((p) => p.old === p.current);
      }
      if (candidates.length !== 1) { issue(options.length > 0 ? "ambiguous-path" : "malformed-section"); return; }
      paths = candidates[0];
    }
    if (deleted && paths.current !== null && paths.old !== paths.current) { issue("malformed-section"); return; }
    const file = paths.current ?? paths.old;
    if (file === null) { issue("malformed-section"); return; }
    const hunks = at === -1 ? "" : s.lines.slice(at).join("\n").replace(/\n+$/, "");
    // Real on-disk size, so the large-file rule fires for binaries over 500 KB. A hunk-less text entry
    // (mode-only change) reports 0: L0 would otherwise read it as a binary-note.
    const size = hunks === "" && !binary ? 0 : sizeOf(workDir, file);
    const f: FileDiff = { file, hunks, truncated: false, size };
    if (paths.old !== null && paths.old !== file) f.oldFile = paths.old;
    if (binary) f.binary = true;
    if (deleted || paths.current === null) f.deleted = true;
    result.files.push(f);
  });
  return result;
}

/** Compatibility projection for callers that only need successfully attributed files. */
export function parseDiffFiles(text: string, workDir?: string): FileDiff[] {
  return parsePatch(text, workDir).files;
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
