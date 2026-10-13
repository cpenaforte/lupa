import { basename } from "node:path";
import { isLockfile, type FileDiff } from "./diff.js";

export interface Finding {
  severity: "info" | "warning" | "high";
  file: string;
  line?: number;
  rule: string;
  message: string;
  suggestion?: string;
  /** Short producer id (e.g. "fastpath", "semgrep", "llm"). Absent = legacy finding. */
  source?: string;
  /** Claimant confidence, integer 0..100. Absent = unmarked (never defaulted). */
  confidence?: number;
  /**
   * Explicit replacement code for the flagged line (Q01). Absent = no patch
   * claim. Stored and rendered verbatim; only `hasPatch` decides applicability.
   */
  patch?: string;
  /** What proves the claim. `snippet` is reserved: assigned by no producer in v1. */
  evidence?: { snippet?: string; analyzer?: string };
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

/**
 * Removes provenance fields (`source`/`confidence`/`evidence`) in place and
 * returns the finding. Agent-mode findings carry no provenance (Q04): applied
 * at both agent exit points — after `agent.ts`'s `toFindings` call and on the
 * single-shot probe-memo branch in `llm.ts` (verdicts kept there).
 */
export function stripProvenance(f: Finding): Finding {
  delete f.source;
  delete f.confidence;
  delete f.evidence;
  return f;
}

function isSensitivePath(file: string): boolean {
  const name = basename(file);
  if (ENV_TEMPLATES.has(name)) return false;
  if (name === "id_rsa") return true;
  if (name.endsWith(".pem")) return true;
  if (name === ".env" || name.startsWith(".env.")) return true;
  return false;
}

/**
 * One shared content classifier over a diff line: strips one trailing CR
 * (CRLF diffs) and returns the text of `+` and unprefixed lines; undefined for
 * context (` `), removed (`-`), no-newline (`\`), hunk headers (`@@`), and
 * empty lines. `todoMarkers` applies it inline while counting new-file lines.
 */
export function contentText(raw: string): string | undefined {
  const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
  if (line === "") return undefined;
  const first = line[0];
  if (first === "+") return line.slice(1);
  if (first === " " || first === "-" || first === "\\") return undefined;
  if (line.startsWith("@@")) return undefined;
  return line;
}

/** Content text of every added or unprefixed line in the hunks (context/removed/headers skipped). */
export function addedLines(hunks: string): string[] {
  const out: string[] = [];
  for (const raw of hunks.split("\n")) {
    const text = contentText(raw);
    if (text !== undefined) out.push(text);
  }
  return out;
}

/** PEM/OpenSSH private-key begin marker, leading-whitespace tolerant (PGP/PuTTY/SSH2-misc out of scope). */
const PRIVATE_KEY_MARKER_RE = /^\s*-----BEGIN (?:RSA |OPENSSH |EC |DSA |ENCRYPTED )?PRIVATE KEY-----/;

/** True when any added line carries a private-key begin marker. */
export function hasPrivateKeyMarker(lines: string[]): boolean {
  return lines.some((line) => PRIVATE_KEY_MARKER_RE.test(line));
}

/** One-pass secret-value normalization: CR → trailing comment → trim → one quote layer → trim. */
export function normalizeSecretValue(raw: string): string {
  let value = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
  value = value.replace(/(?:^|\s+)#.*$/, "");
  value = value.trim();
  if (value.length >= 2) {
    const first = value[0];
    if ((first === '"' || first === "'") && value.endsWith(first)) value = value.slice(1, -1);
  }
  return value.trim();
}

const PLACEHOLDER_LITERALS: ReadonlySet<string> = new Set([
  "changeme", "change-me", "example", "sample", "test", "testing", "xxx",
  "password", "password123", "123456", "placeholder", "none",
]);

/** Whole-value placeholder detection over the normalized value (empty/`$VAR`/literals/patterns). */
export function isPlaceholderValue(rawValue: string): boolean {
  const value = normalizeSecretValue(rawValue);
  if (value === "") return true;
  if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value)) return true;
  if (/^\$\{[^}]*\}$/.test(value)) return true;
  if (PLACEHOLDER_LITERALS.has(value.toLowerCase())) return true;
  if (/EXAMPLE_NOT_A_SECRET/i.test(value)) return true;
  if (/^AKIAIOSFODNN7EXAMPLE/i.test(value)) return true;
  if (/^ghp_EXAMPLE/i.test(value)) return true;
  if (/^x+$/i.test(value)) return true;
  if (/^<[^>]*>$/.test(value)) return true;
  if (/^\*+$/.test(value)) return true;
  return false;
}

const SECRET_KEY_SUBSTRING_RE =
  /(?:SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|API[_-]?KEY|AUTH[_-]?TOKEN|ACCESS[_-]?KEY|SESSION[_-]?KEY)/i;
const SECRET_KEY_SEGMENTS: ReadonlySet<string> = new Set([
  "PASS", "SIGNING", "ENCRYPTION", "MASTER", "AUTH", "AUTHORIZATION",
]);

/** Secret-shaped key name: substring hit OR a `_`/`-`-delimited segment in the pinned set. */
export function isSecretKeyName(key: string): boolean {
  if (SECRET_KEY_SUBSTRING_RE.test(key)) return true;
  return key.split(/[_-]/).some((segment) => SECRET_KEY_SEGMENTS.has(segment.toUpperCase()));
}

const NUMERIC_VALUE_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const BOOLEAN_VALUE_RE = /^(true|false|yes|no|on|off)$/i;
const URL_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/** True for a URL whose authority (between `://` and the next `/`) carries no `@` userinfo. */
function isCredentiallessUrl(value: string): boolean {
  const scheme = URL_SCHEME_RE.exec(value);
  if (scheme === null) return false;
  const rest = value.slice(scheme[0].length);
  const slash = rest.indexOf("/");
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  return !authority.includes("@");
}

/** A real assignment value: non-placeholder AND not numeric/boolean/credential-less URL. */
export function isSecretValue(rawValue: string): boolean {
  if (isPlaceholderValue(rawValue)) return false;
  const value = normalizeSecretValue(rawValue);
  if (NUMERIC_VALUE_RE.test(value)) return false;
  if (BOOLEAN_VALUE_RE.test(value)) return false;
  if (isCredentiallessUrl(value)) return false;
  return true;
}

/** dotenv subset: `[export ]KEY=value`; `#`-led, dashed-key, `KEY+=`, and multiline values are out of scope. */
const ENV_ASSIGNMENT_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)$/;

/**
 * Added-line evidence for a non-deleted sensitive path. A private-key marker on
 * any added line proves secret material; `.env`/`.env.*` additionally flags a
 * secret-shaped key assigned a real (non-placeholder, non-obvious) value.
 */
function sensitiveEvidence(file: string, hunks: string): boolean {
  const lines = addedLines(hunks);
  if (hasPrivateKeyMarker(lines)) return true;
  const name = basename(file);
  if (name !== ".env" && !name.startsWith(".env.")) return false;
  return lines.some((line) => {
    const m = ENV_ASSIGNMENT_RE.exec(line);
    return m !== null && isSecretKeyName(m[1]!) && isSecretValue(m[2]!);
  });
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
    if (f.deleted === true) continue;

    if (isSensitivePath(f.file) && sensitiveEvidence(f.file, f.hunks)) {
      out.push({
        severity: "high",
        file: f.file,
        rule: "sensitive-path",
        message: `Sensitive file path changed: ${f.file}`,
        source: "fastpath",
        confidence: 50,
      });
    }

    if ((f.size ?? 0) > LARGE_FILE_BYTES) {
      out.push({
        severity: "warning",
        file: f.file,
        rule: "large-file",
        message: `File larger than 500KB: ${f.file}`,
        source: "fastpath",
        confidence: 50,
      });
    }

    if (f.binary === true || (f.hunks === "" && (f.size ?? 0) > 0)) {
      out.push({
        severity: "info",
        file: f.file,
        rule: "binary-note",
        message: `Binary or non-text change, not reviewed: ${f.file}`,
        source: "fastpath",
        confidence: 50,
      });
    }

    if (isLockfile(f.file) && !hasManifestFor(basename(f.file))) {
      out.push({
        severity: "warning",
        file: f.file,
        rule: "lockfile-without-manifest",
        message: `Lockfile changed without its manifest: ${f.file}`,
        source: "fastpath",
        confidence: 50,
      });
    }

    for (const { line, text } of todoMarkers(f.hunks)) {
      out.push({
        severity: "info",
        file: f.file,
        line,
        rule: "todo-marker",
        message: `TODO/FIXME/XXX marker: ${text.trim()}`,
        source: "fastpath",
        confidence: 50,
      });
    }
  }

  return out;
}

const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Scans unified-diff hunks for TODO/FIXME/XXX on ADDED or unprefixed content
 * lines only (add-only, via the shared `contentText` classifier). Context (` `)
 * and empty lines advance the new-file counter exactly as today but are never
 * scanned; removed (`-`) and no-newline (`\`) lines are skipped entirely; `@@`
 * headers are never content and never advance. Input with no `@@` header is
 * treated as new-file content counted from 1.
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
    let line: number;
    if (newLine !== undefined) {
      line = newLine;
      newLine += 1;
    } else {
      line = fallback;
      fallback += 1;
    }
    const text = contentText(raw);
    if (text !== undefined && TODO_RE.test(text)) out.push({ line, text });
  }
  return out;
}
