import type { Finding } from "../domain/finding.js";
import { buildMessages, ISSUE_TRUNCATION_MARKER, neutralise } from "../prompt.js";

/** Prefix of `s` holding at most `maxBytes` UTF-8 bytes, cut on a code-point boundary. */
function cutToBytes(s: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const ch of s) {
    const bl = Buffer.byteLength(ch, "utf8");
    if (bytes + bl > maxBytes) break;
    bytes += bl;
    end += ch.length;
  }
  return s.slice(0, end);
}

/**
 * Fits the structured prompt regions into `budget` UTF-8 bytes. Cut order:
 * linked-issue context first (truncate with a marker, or drop when the
 * allowance is negative), then whole fast findings from the tail with a
 * re-rendered omitted count; the diff is never cut. Every region is
 * neutralised first, exactly as `buildMessages` renders it, and every
 * measurement runs on the rendered string. Findings objects pass through
 * (only their serialized form is escaped at render); posting and artifacts
 * keep using the full `fast` array, so omitted findings still reach the review.
 */
export function budgetPrompt(
  fast: Finding[],
  promptText: string,
  issueBody: string | undefined,
  skipped: string[],
  budget: number,
  opts?: { withIds?: boolean },
): { fast: Finding[]; promptText: string; issueBody: string | undefined; skipped: string[]; findingsOmitted: number; issueDropped: boolean } {
  const nPrompt = neutralise(promptText);
  const nIssueFull = issueBody !== undefined && issueBody.trim() !== "" ? neutralise(issueBody) : undefined;
  const render = (f: Finding[], ib: string | undefined, omitted: number): string =>
    buildMessages(f, nPrompt, ib, skipped, undefined, omitted, opts).user;

  let curIssue = nIssueFull;
  let issueDropped = false;
  let kept = [...fast];
  let omitted = 0;

  if (Buffer.byteLength(render(kept, curIssue, 0), "utf8") <= budget) {
    return { fast: kept, promptText: nPrompt, issueBody: curIssue, skipped: skipped.map(neutralise), findingsOmitted: 0, issueDropped: false };
  }

  // Step 1: linked-issue context. The allowance is sized once against the full
  // findings set: budget minus everything else plus the fixed cost of carrying
  // any issue text (header, separators, tags, marker — byte-exact, measured on
  // the rendered regions, never estimated).
  if (curIssue !== undefined) {
    const noIssueBytes = Buffer.byteLength(render(kept, undefined, 0), "utf8");
    const markerBytes = Buffer.byteLength(ISSUE_TRUNCATION_MARKER, "utf8");
    const issueOverhead =
      Buffer.byteLength(render(kept, ISSUE_TRUNCATION_MARKER, 0), "utf8") - noIssueBytes - markerBytes;
    const allowance = budget - noIssueBytes - issueOverhead;
    if (allowance < markerBytes) {
      curIssue = undefined;
      issueDropped = true;
    } else if (Buffer.byteLength(curIssue, "utf8") > allowance) {
      curIssue = cutToBytes(curIssue, allowance - markerBytes) + ISSUE_TRUNCATION_MARKER;
    }
  }

  // Step 2: fast-findings overflow. Whole findings dropped from the tail with a
  // re-rendered count — never mid-finding cuts, so the JSON stays parseable.
  while (kept.length > 0 && Buffer.byteLength(render(kept, curIssue, omitted), "utf8") > budget) {
    kept = kept.slice(0, -1);
    omitted += 1;
  }

  return { fast: kept, promptText: nPrompt, issueBody: curIssue, skipped: skipped.map(neutralise), findingsOmitted: omitted, issueDropped };
}
