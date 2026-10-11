import type { Finding } from "./fastpath.js";
import type { FailLevel } from "./inputs.js";
import type { HunkLine, ParsedHunk } from "./diff.js";
import { redact } from "./llm.js";

export interface InlineComment {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  /** Reserved for v2 multi-line ranges. Never set in v1 (see mapToComments). */
  start_line?: number;
  /** Reserved for v2 multi-line ranges. Never set in v1 (see mapToComments). */
  start_side?: "LEFT" | "RIGHT";
  body: string;
}

export interface ReviewPayload {
  commit_id: string;
  body: string;
  event: "COMMENT" | "REQUEST_CHANGES";
  comments: InlineComment[];
}

function keyOf(side: "LEFT" | "RIGHT", line: number): string {
  return `${side}:${line}`;
}

function isValidLine(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1;
}

function hasSuggestion(f: Finding): f is Finding & { suggestion: string } {
  return typeof f.suggestion === "string" && f.suggestion !== "";
}

/**
 * Fence for a ```suggestion block: one backtick longer than the longest backtick run in
 * the suggestion (minimum three), so the suggestion can never close its own fence.
 */
function fenceFor(suggestion: string): string {
  let longest = 0;
  for (const run of suggestion.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * Inline body. Only RIGHT-side hits get a ```suggestion fence (a suggestion replaces the
 * commented line, which only exists on the new side). LEFT hits show the suggestion as
 * plain text instead.
 */
function formatBody(f: Finding, side: "LEFT" | "RIGHT"): string {
  let body = `**${f.severity}** [${f.rule}] ${f.message}`;
  if (hasSuggestion(f)) {
    if (side === "RIGHT") {
      const fence = fenceFor(f.suggestion);
      body += `\n\n${fence}suggestion\n${f.suggestion}\n${fence}`;
    } else {
      body += `\n\nSuggested: ${f.suggestion.replace(/\n/g, "\n  ")}`;
    }
  }
  return body;
}

/**
 * Maps findings onto commentable diff lines. A finding becomes an inline comment only when
 * its file and line are both present in the hunks; everything else (repo-level, line-less,
 * off-diff) goes to the general list, which the caller folds into the review body.
 *
 * Same line number on both sides: RIGHT wins deterministically. Findings reference new-file
 * line numbers, and a LEFT hit is used only when no RIGHT line carries that number.
 *
 * v1 never emits multi-line ranges: start_line/start_side stay unset, so a suggestion
 * replaces only the single flagged line.
 */
export function mapToComments(
  findings: Finding[],
  hunks: ParsedHunk[],
): { inline: InlineComment[]; general: Finding[] } {
  const index = new Map<string, Map<string, HunkLine>>();
  for (const h of hunks) {
    let byKey = index.get(h.file);
    if (byKey === undefined) {
      byKey = new Map();
      index.set(h.file, byKey);
    }
    for (const l of h.lines) {
      const k = keyOf(l.side, l.line);
      if (!byKey.has(k)) byKey.set(k, l);
    }
  }

  const inline: InlineComment[] = [];
  const general: Finding[] = [];
  for (const f of findings) {
    const byKey = f.file === "" ? undefined : index.get(f.file);
    if (byKey === undefined || !isValidLine(f.line)) {
      general.push(f);
      continue;
    }
    const line = f.line;
    const hit = byKey.get(keyOf("RIGHT", line)) ?? byKey.get(keyOf("LEFT", line));
    if (hit === undefined) {
      general.push(f);
      continue;
    }
    inline.push({ path: f.file, line, side: hit.side, body: formatBody(f, hit.side) });
  }
  return { inline, general };
}

/** `high` requests changes only on high-severity evidence; `none` and `warning` never do. */
export function eventFor(failLevel: FailLevel, findings: Finding[]): "COMMENT" | "REQUEST_CHANGES" {
  if (failLevel === "high" && findings.some((f) => f.severity === "high")) return "REQUEST_CHANGES";
  return "COMMENT";
}

/**
 * Exit code for the fail_level gate. `none` never fails; `warning` fails on any non-info
 * finding (info-only never fails); `high` fails only on high-severity evidence.
 */
export function exitFor(failLevel: FailLevel, findings: Finding[]): number {
  if (failLevel === "none") return 0;
  if (failLevel === "warning") return findings.some((f) => f.severity !== "info") ? 2 : 0;
  return findings.some((f) => f.severity === "high") ? 1 : 0;
}

const FALLBACK_SUMMARY = "pr-reviewer: review complete.";

/**
 * Replaces every non-empty secret in `message`, `suggestion`, `file` and
 * `rule` with the redaction marker. Empty secrets are skipped: redacting
 * with an empty key would interleave markers between every character.
 */
export function redactFindings(findings: Finding[], secrets: readonly string[]): Finding[] {
  const keys = secrets.filter((s) => s !== "");
  return findings.map((f) => {
    let out = f;
    for (const key of keys) {
      out = {
        ...out,
        message: redact(out.message, key),
        file: redact(out.file, key),
        rule: redact(out.rule, key),
        ...(out.suggestion !== undefined ? { suggestion: redact(out.suggestion, key) } : {}),
      };
    }
    return out;
  });
}

/** `file:line`, `file` when there is no line, `(repository)` for repo-level findings. */
function locate(f: Finding): string {
  if (f.file === "") return "(repository)";
  return isValidLine(f.line) ? `${f.file}:${f.line}` : f.file;
}

/**
 * Review body: summary plus any findings that could not be placed inline. Suggestions are
 * rendered as plain text here (never as a fence). Never empty.
 */
export function buildBody(general: Finding[], summary: string): string {
  const head = summary.trim() === "" ? FALLBACK_SUMMARY : summary.trim();
  if (general.length === 0) return head;
  const items = general.map((f) => {
    let item = `- **${f.severity}** ${locate(f)} [${f.rule}] ${f.message}`;
    if (hasSuggestion(f)) item += `\n  Suggested: ${f.suggestion.replace(/\n/g, "\n  ")}`;
    return item;
  });
  return `${head}\n\n**Findings not placed inline:**\n${items.join("\n")}`;
}
