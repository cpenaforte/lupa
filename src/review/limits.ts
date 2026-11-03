import type { Finding } from "../domain/finding.js";
import { TRUNC_MARK } from "../domain/text.js";


/**
 * The single gate for every patch rendering site (Q01): a patch fences/renders
 * **iff** its stored (sanitized) value is a non-empty, non-whitespace-only
 * string that was NOT capped. The trim lives ONLY in this test — the stored and
 * rendered value stays verbatim. A value ending in TRUNC_MARK was capped by
 * `sanitizeFinding`, so it is advice-only and never fenced.
 */
export function hasPatch(f: Finding): f is Finding & { patch: string } {
  return typeof f.patch === "string" && f.patch.trim() !== "" && !f.patch.endsWith(TRUNC_MARK);
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
  if (markers.length === 0 && codePointsOf(body) <= maxChars) {
    let stale = false;
    for (const line of body.split(/\r?\n/)) {
      if (isTruncNoteLine(line)) {
        stale = true;
        break;
      }
    }
    // Passthrough: no markers, no stale notes, fits the cap — return the
    // body untouched (CRLF and marker-looking lines preserved as-is). Line
    // normalization below only ever touches capped or marker-processed bodies.
    if (!stale) return body;
  }
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
