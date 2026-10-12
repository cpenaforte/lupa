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

const FALLBACK_SUMMARY = "lupa: review complete.";

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

/** A complete, standalone report for fallback destinations. */
export function buildFallbackReport(
  findings: readonly Finding[],
  options: { maxBytes?: number } = {},
): string {
  const heading = findings.length === 0 ? "lupa: no findings." : `lupa: ${findings.length} finding(s).`;
  const fullRecords = findings.map((f, index) => {
    const field = (value: string): string => {
      const fence = fenceFor(value);
      return `${fence}text\n${value}\n${fence}`;
    };
    const suggestion = hasSuggestion(f) ? f.suggestion : "No remediation supplied";
    return [
      `### Finding ${index + 1}`,
      "",
      `- Severity: ${f.severity}`,
      `- Location:\n${field(locate(f))}`,
      `- Rule:\n${field(f.rule)}`,
      `- Message/evidence:\n${field(f.message)}`,
      `- Suggested remediation (advice only):\n${field(suggestion)}`,
    ].join("\n");
  });
  const recordBytes = fullRecords.map((record) => Buffer.byteLength(record, "utf8"));
  // Each prefix total includes the blank-line separators between its complete records.
  const prefixBytes = [0];
  for (const length of recordBytes) {
    const previous = prefixBytes[prefixBytes.length - 1]!;
    prefixBytes.push(previous + (prefixBytes.length > 1 ? 2 : 0) + length);
  }
  const headingBytes = Buffer.byteLength(heading, "utf8");
  const render = (retained: number, marker?: string): string => {
    const records = fullRecords.slice(0, retained).join("\n\n");
    if (marker === undefined) return retained === 0 ? heading : `${heading}\n\n${records}`;
    return retained === 0 ? `${heading}\n\n${marker}` : `${heading}\n\n${records}\n\n${marker}`;
  };

  if (options.maxBytes === undefined) {
    return render(findings.length);
  }
  const maxBytes = options.maxBytes;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError("maxBytes must be a non-negative safe integer");
  if (findings.length === 0) {
    if (headingBytes <= maxBytes) return heading;
    throw new RangeError("maxBytes is too small for the report heading");
  }
  if (headingBytes + 2 + prefixBytes[findings.length]! <= maxBytes) return render(findings.length);

  let retained = -1;
  let omissionMarker = "";
  for (let candidateRetained = findings.length - 1; candidateRetained >= 0; candidateRetained--) {
    const omitted = findings.length - candidateRetained;
    const marker = `> Omitted: ${omitted} finding(s) omitted because the report output limit was reached.`;
    const candidateBytes = headingBytes + 2 + prefixBytes[candidateRetained]! + (candidateRetained > 0 ? 2 : 0) + Buffer.byteLength(marker, "utf8");
    if (candidateBytes <= maxBytes) {
      // Descending from the full count selects the longest fitting input-order prefix.
      retained = candidateRetained;
      omissionMarker = marker;
      break;
    }
  }
  if (retained < 0) throw new RangeError("maxBytes is too small for the report heading and omission marker");
  return render(retained, omissionMarker);
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

// ---------------------------------------------------------------------------
// Publication funnel (F15). The helpers below bound the published review while
// mapToComments/buildBody/buildFallbackReport above stay unchanged.
// ---------------------------------------------------------------------------

const SEVERITY_RANK: Record<Finding["severity"], number> = { high: 0, warning: 1, info: 2 };

/**
 * Orders findings for retention: `high` first, then `warning`, then `info`.
 * Ties keep input order (stable — deterministic across runs). Findings and
 * severities are never rewritten; only the order changes. The input array is
 * not mutated.
 */
export function prioritizeFindings(findings: Finding[]): Finding[] {
  return findings
    .map((finding, index) => ({ finding, index }))
    .sort(
      (a, b) => SEVERITY_RANK[a.finding.severity] - SEVERITY_RANK[b.finding.severity] || a.index - b.index,
    )
    .map(({ finding }) => finding);
}

/** Exact publication marker for findings dropped by the top-N cap. */
export function omissionMarkerFor(omitted: number, maxFindings: number): string {
  return `> Omitted: ${omitted} finding(s) omitted to fit the ${maxFindings}-finding publication limit.`;
}

/** Exact truncation note appended when the body char cap cuts content. */
export function truncNoteFor(maxChars: number): string {
  return `> Note: review body truncated to the ${maxChars}-character limit.`;
}

const TRUNC_NOTE_RE = /^> Note: review body truncated to the \d+-character limit\.$/;

/** Whether a single body line is a truncation note (any cap value, top-level only). */
export function isTruncNoteLine(line: string): boolean {
  return TRUNC_NOTE_RE.test(line);
}

const codePointsOf = (s: string): number => Array.from(s).length;

/** A body line that opens or closes a fenced block (leading whitespace ignored: folded bodies indent fences). */
function isFenceLine(line: string): boolean {
  return line.trimStart().startsWith("```");
}

/** Whole-line cut of a budget-sized candidate: back to the last `\n`, or mid-line when there is none. */
function wholeLineCut(candidate: string): string {
  const idx = candidate.lastIndexOf("\n");
  return idx === -1 ? candidate : candidate.slice(0, idx);
}

/**
 * Fence-aware backup: while the retained lines hold an unclosed fence, drop
 * back to before its opening line. Each pass removes at least one line, so
 * this always terminates (fence lines are short whole lines).
 */
function fenceBackup(text: string): string {
  let lines = text.split("\n");
  for (;;) {
    let count = 0;
    let last = -1;
    for (let i = 0; i < lines.length; i++) {
      if (isFenceLine(lines[i] as string)) {
        count++;
        last = i;
      }
    }
    if (count % 2 === 0 || last === -1) return lines.join("\n");
    lines = lines.slice(0, last);
  }
}

/** Cuts content to a code-point budget: whole lines, fence-aware, code-point-safe mid-line fallback. */
function cutContent(content: string, budget: number): string {
  if (codePointsOf(content) <= budget) return content;
  const candidate = Array.from(content)
    .slice(0, Math.max(0, budget))
    .join("");
  return fenceBackup(wholeLineCut(candidate));
}

/**
 * Caps a review body to `maxChars` Unicode code points with the given markers
 * guaranteed inside the cap. Markers are always appended in argument order —
 * even when the content fits. Over-long content is cut whole-line (fence-aware;
 * code-point-safe mid-line fallback) and witnessed by the truncation note,
 * which is always last. Stale truncation notes are stripped silently, and
 * top-level `> Omitted:` lines found in the body are lifted into the marker
 * set (deduplicated), so re-capping never stacks notes or repeats counts.
 * When the caller already passes a trunc-note-template line as a marker (the
 * fold re-cap path, which reserves the note budget up front), no second note
 * is appended. Throws RangeError when the markers alone exceed the cap.
 */
export function capBody(body: string, maxChars: number, markers: string[]): string {
  const note = truncNoteFor(maxChars);
  const contentLines: string[] = [];
  const lifted: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (isTruncNoteLine(line)) continue;
    if (line.startsWith("> Omitted:")) {
      if (!markers.includes(line) && !lifted.includes(line)) lifted.push(line);
      continue;
    }
    contentLines.push(line);
  }
  const content = contentLines.join("\n");
  const tails = [...markers, ...lifted];
  const tailsBlock = tails.join("\n");
  if (codePointsOf(tailsBlock) > maxChars) {
    throw new RangeError(
      `capBody: markers (${codePointsOf(tailsBlock)} chars) exceed the ${maxChars}-character limit`,
    );
  }
  const headed = (head: string): string =>
    head === "" ? tailsBlock : tails.length === 0 ? head : `${head}\n${tailsBlock}`;
  if (codePointsOf(headed(content)) <= maxChars) return headed(content);
  const tail = tails.some((m) => isTruncNoteLine(m)) ? tails : [...tails, note];
  const tailBlock = tail.join("\n");
  if (codePointsOf(tailBlock) > maxChars) {
    // Degenerate and unreachable via inputs (whose 1000 floor dwarfs markers
    // plus the note): the markers fit but the note does not fit alongside
    // them. Preserve the markers; with no markers at all keep a best-effort
    // content prefix instead of an empty body.
    if (tails.length > 0) return tailsBlock;
    return cutContent(content, maxChars);
  }
  const cut = cutContent(content, maxChars - codePointsOf(tailBlock) - 1);
  return cut === "" ? tailBlock : `${cut}\n${tailBlock}`;
}
