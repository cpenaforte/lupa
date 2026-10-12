import { basename } from "node:path";
import { isLockfile, type FileDiff } from "./diff.js";

export interface Finding {
  severity: "info" | "warning" | "high";
  file: string;
  line?: number;
  rule: string;
  message: string;
  suggestion?: string;
}

/** Finding-text caps (finding-contract home; imported by main.ts and review.ts — behavior unchanged). */
export const MSG_CAP = 2000;
export const RULE_CAP = 100;
export const TRUNC_MARK = "…[truncated]";

/**
 * Caps by code points (not UTF-16 units), so a cut never splits a surrogate pair.
 * The cap includes the truncation marker.
 */
export function capText(s: string, cap: number): string {
  const cps = Array.from(s);
  if (cps.length <= cap) return s;
  return cps.slice(0, cap - Array.from(TRUNC_MARK).length).join("") + TRUNC_MARK;
}

const LARGE_FILE_BYTES = 500 * 1024;
const TODO_RE = /\b(TODO|FIXME|XXX)\b/;

/** Filename-level sensitive-path rules (basename match). */
/** Committed templates of env files. They hold placeholders, not secrets, so they are not flagged. */
const ENV_TEMPLATES: ReadonlySet<string> = new Set([".env.example", ".env.sample", ".env.template"]);

function isSensitivePath(file: string): boolean {
  const name = basename(file);
  if (ENV_TEMPLATES.has(name)) return false;
  if (name === "id_rsa") return true;
  if (name.endsWith(".pem")) return true;
  if (name === ".env" || name.startsWith(".env.")) return true;
  return false;
}

/**
 * Deterministic fast-path checks. Runs on the UNFILTERED file list.
 * `hasManifestFor(lockfile)` is the caller's per-ecosystem lookup; when omitted,
 * every lockfile is treated as lacking a manifest (conservative).
 */
export function runL0(
  files: FileDiff[],
  o: { hasManifestFor?: (lockfile: string) => boolean } = {},
): Finding[] {
  const hasManifestFor = o.hasManifestFor ?? (() => false);
  const out: Finding[] = [];

  for (const f of files) {
    if (isSensitivePath(f.file)) {
      out.push({
        severity: "high",
        file: f.file,
        rule: "sensitive-path",
        message: `Sensitive file path changed: ${f.file}`,
      });
    }

    if ((f.size ?? 0) > LARGE_FILE_BYTES) {
      out.push({
        severity: "warning",
        file: f.file,
        rule: "large-file",
        message: `File larger than 500KB: ${f.file}`,
      });
    }

    if (f.binary === true || (f.hunks === "" && (f.size ?? 0) > 0)) {
      out.push({
        severity: "info",
        file: f.file,
        rule: "binary-note",
        message: `Binary or non-text change, not reviewed: ${f.file}`,
      });
    }

    if (isLockfile(f.file) && !hasManifestFor(basename(f.file))) {
      out.push({
        severity: "warning",
        file: f.file,
        rule: "lockfile-without-manifest",
        message: `Lockfile changed without its manifest: ${f.file}`,
      });
    }

    for (const { line, text } of todoMarkers(f.hunks)) {
      out.push({
        severity: "info",
        file: f.file,
        line,
        rule: "todo-marker",
        message: `TODO/FIXME/XXX marker: ${text.trim()}`,
      });
    }
  }

  return out;
}

const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Scans unified-diff hunks for TODO/FIXME/XXX on ADDED or CONTEXT lines and
 * reports real new-file line numbers. Removed (`-`) lines are skipped entirely.
 * Input with no `@@` header is treated as new-file content counted from 1.
 */
function todoMarkers(hunks: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  let newLine: number | undefined; // next new-file line; undefined until a header
  let fallback = 1;
  for (const raw of hunks.split("\n")) {
    const header = HUNK_HEADER_RE.exec(raw);
    if (header) {
      newLine = Number(header[1]);
      continue;
    }
    if (raw.startsWith("-") || raw.startsWith("\\")) continue;
    const text = raw.startsWith("+") || raw.startsWith(" ") ? raw.slice(1) : raw;
    let line: number;
    if (newLine !== undefined) {
      line = newLine;
      newLine += 1;
    } else {
      line = fallback;
      fallback += 1;
    }
    if (TODO_RE.test(text)) out.push({ line, text });
  }
  return out;
}
