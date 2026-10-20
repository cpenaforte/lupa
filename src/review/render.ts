import { unsafePath } from "../domain/finding.js";
import type { Finding } from "../domain/finding.js";
import type { ParsedHunk } from "../domain/diff.js";
import type { InlineComment } from "../domain/review.js";
import { redact } from "../domain/text.js";
import { hunkHit, indexHunks, isValidLine, reopenedKey } from "./policy.js";
import { hasPatch } from "./limits.js";


function hasSuggestion(f: Finding): f is Finding & { suggestion: string } {
  return typeof f.suggestion === "string" && f.suggestion !== "";
}

/**
 * Fence sized for a rendered code block: one backtick longer than the longest
 * backtick run in the content (minimum three), so the block can never close its
 * own fence. Used for the RIGHT ```suggestion fence and the advice-only
 * replacement blocks (LEFT/general/fallback) — never for prose.
 */
function fenceFor(content: string): string {
  let longest = 0;
  for (const run of content.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * Provenance trailer (Q04, display-only): compact `` `src:<source> · conf <n>` ``
 * appended after the message/suggestion/patch — AFTER any patch fence or
 * `Suggested:` block, never inside a patch. Partials: source-only renders
 * `` `src:<source>` ``, confidence-only `` `conf <n>` ``, neither renders
 * nothing. `confidence: 0` renders (`conf 0` — presence-tested, never
 * truthiness-tested). The trailer is part of the item text: it is appended
 * before any `capBody` cut and may be truncated with the item.
 */
function provenanceTrailer(f: Finding): string {
  const parts: string[] = [];
  if (f.source !== undefined) parts.push(`src:${f.source}`);
  if (f.confidence !== undefined) parts.push(`conf ${f.confidence}`);
  return parts.length === 0 ? "" : `\n\n\`${parts.join(" · ")}\``;
}

/**
 * Inline body. The applicable ```suggestion fence renders **iff** `hasPatch(f)`
 * on a RIGHT-side hit — a patch replaces the commented new-side line, which only
 * exists on the new side; a patch failing `hasPatch` fences nowhere. A patch on a
 * LEFT hit renders as an advice-only replacement block (label + plain fence
 * sized by `fenceFor(patch)`) instead of a ```suggestion fence. `suggestion`,
 * when present, always renders as `Suggested:` advice text — on RIGHT hits too,
 * it no longer fences anywhere. A reopened finding renders `**reopened**`
 * between the severity and the rule (`**high** **reopened** [rule] ...`) — the
 * thread-fetch rule parser tolerates this marker, so a re-posted thread stays
 * parseable.
 */
export function formatBody(f: Finding, side: "LEFT" | "RIGHT", reopened = false): string {
  let body = reopened ? `**${f.severity}** **reopened** [${f.rule}] ${f.message}` : `**${f.severity}** [${f.rule}] ${f.message}`;
  if (hasPatch(f)) {
    const fence = fenceFor(f.patch);
    if (side === "RIGHT") {
      body += `\n\n${fence}suggestion\n${f.patch}\n${fence}`;
    } else {
      body += `\n\nSuggested replacement (advice only):\n${fence}\n${f.patch}\n${fence}`;
    }
  }
  if (hasSuggestion(f)) {
    body += `\n\nSuggested: ${f.suggestion.replace(/\n/g, "\n  ")}`;
  }
  return body + provenanceTrailer(f);
}

/**
 * Maps findings onto commentable diff lines. A finding becomes an inline comment only when
 * its file and line are both present in the hunks; everything else (repo-level, line-less,
 * off-diff) goes to the general list, which the caller folds into the review body.
 *
 * Same line number on both sides: RIGHT wins deterministically. Findings reference new-file
 * line numbers, and a LEFT hit is used only when no RIGHT line carries that number.
 *
 * v1 never emits multi-line ranges: start_line/start_side stay unset, so a patch
 * replaces only the single flagged line.
 *
 * Each inline comment carries the finding's rule for fold keys (INTERNAL: stripped
 * before posting, so payload shapes are unchanged). Items whose key is in
 * `reopened` render the `**reopened**` marker via formatBody.
 */
export function mapToComments(
  findings: Finding[],
  hunks: ParsedHunk[],
  reopened?: ReadonlySet<string>,
  identityMarkers?: ReadonlyMap<Finding, string>,
): { inline: InlineComment[]; general: Finding[] } {
  const index = indexHunks(hunks);
  const inline: InlineComment[] = [];
  const general: Finding[] = [];
  for (const f of findings) {
    if (!isValidLine(f.line)) {
      general.push(f);
      continue;
    }
    const line = f.line;
    const hit = hunkHit(index, f.file, line);
    if (hit === undefined) {
      general.push(f);
      continue;
    }
    const isReopened = reopened?.has(reopenedKey(f)) === true;
    const marker = identityMarkers?.get(f);
    const body = formatBody(f, hit.side, isReopened) + (marker === undefined ? "" : `\n\n${marker}`);
    inline.push({ path: f.file, line, side: hit.side, body, rule: f.rule });
  }
  return { inline, general };
}

const FALLBACK_SUMMARY = "lupa: review complete.";

/**
 * Replaces every non-empty secret in `message`, `suggestion`, `patch`, `file`,
 * `rule`, and `evidence.*` with the redaction marker. Empty secrets are
 * skipped: redacting with an empty key would interleave markers between
 * every character. The `evidence` object is always copied fresh, so mutating
 * the input afterwards never alters the redacted output.
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
        ...(out.patch !== undefined ? { patch: redact(out.patch, key) } : {}),
        ...(out.evidence !== undefined
          ? {
              evidence: {
                ...(out.evidence.analyzer !== undefined ? { analyzer: redact(out.evidence.analyzer, key) } : {}),
                ...(out.evidence.snippet !== undefined ? { snippet: redact(out.evidence.snippet, key) } : {}),
              },
            }
          : {}),
      };
    }
    // Copy-on-write: the spread above shares the input's evidence object when
    // no key touched it (or no secrets were given) — always hand out a fresh
    // object so later input mutation cannot leak into redacted output.
    if (out.evidence !== undefined && out.evidence === f.evidence) {
      out = { ...out, evidence: { ...out.evidence } };
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
    const provenance: string[] = [];
    if (f.source !== undefined) provenance.push(`- Source:\n${field(f.source)}`);
    if (f.confidence !== undefined) provenance.push(`- Confidence:\n${field(String(f.confidence))}`);
    if (f.evidence !== undefined && (f.evidence.analyzer !== undefined || f.evidence.snippet !== undefined)) {
      const parts: string[] = [];
      if (f.evidence.analyzer !== undefined) parts.push(field(`analyzer: ${f.evidence.analyzer}`));
      if (f.evidence.snippet !== undefined) parts.push(field(f.evidence.snippet));
      provenance.push(`- Evidence:\n${parts.join("\n")}`);
    }
    return [
      `### Finding ${index + 1}`,
      "",
      `- Severity: ${f.severity}`,
      `- Location:\n${field(locate(f))}`,
      `- Rule:\n${field(f.rule)}`,
      `- Message/evidence:\n${field(f.message)}`,
      ...provenance,
      `- Suggested remediation (advice only):\n${field(suggestion)}`,
      ...(hasPatch(f) ? [`- Proposed patch (advice only):\n${field(f.patch)}`] : []),
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
 * Review body: summary plus any findings that could not be placed inline.
 * General items never render a ```suggestion fence: a valid patch (`hasPatch`)
 * renders as an advice-only replacement block (label, then a plain fence sized
 * by `fenceFor(patch)`), and `suggestion` renders as plain `Suggested:` text.
 * Continuation lines indent with `\n  `. Never empty.
 *
 * Blocking display: every body item in `marks.blocking` carries a marker after the
 * severity — `**reopened**` when also in `marks.reopened`, else `**blocking**`
 * (reachable only by lineless-in-diff findings; lined introduced items are inline,
 * never in the body). When at least one body item is outside the blocking set, a
 * header note precedes the findings heading (omitted when zero).
 */
export function buildBody(
  general: Finding[],
  summary: string,
  marks?: { reopened?: ReadonlySet<string>; blocking?: ReadonlySet<string> },
): string {
  const head = summary.trim() === "" ? FALLBACK_SUMMARY : summary.trim();
  if (general.length === 0) return head;
  const reopened = marks?.reopened;
  const blocking = marks?.blocking;
  const items = general.map((f) => {
    const key = reopenedKey(f);
    const marker =
      reopened?.has(key) === true ? " **reopened**" : blocking?.has(key) === true ? " **blocking**" : "";
    let item = `- **${f.severity}**${marker} ${locate(f)} [${f.rule}] ${f.message}`;
    if (hasPatch(f)) {
      const fence = fenceFor(f.patch);
      item += `\n  Suggested replacement (advice only):\n  ${fence}\n  ${f.patch.replace(/\n/g, "\n  ")}\n  ${fence}`;
    }
    if (hasSuggestion(f)) item += `\n  Suggested: ${f.suggestion.replace(/\n/g, "\n  ")}`;
    return item + provenanceTrailer(f).replace(/\n/g, "\n  ");
  });
  const outside = general.filter((f) => blocking?.has(reopenedKey(f)) !== true).length;
  const list = `**Findings not placed inline:**\n${items.join("\n")}`;
  if (outside === 0) return `${head}\n\n${list}`;
  return `${head}\n\n**Note:** ${outside} finding(s) below are outside the PR diff and do not block.\n\n${list}`;
}

/**
 * SARIF 2.1.0 for code scanning: warning and high findings only (info stays in the review and the
 * artifact), and only findings with a safe repository path (code scanning needs a location).
 */
export function toSarif(findings: Finding[]): unknown {
  const level = (s: Finding["severity"]): string => (s === "high" ? "error" : s === "warning" ? "warning" : "note");
  const results = findings
    .filter((f) => f.severity !== "info" && f.file !== "" && !unsafePath(f.file))
    .map((f) => ({
      ruleId: f.rule,
      level: level(f.severity),
      message: { text: f.message },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: f.file },
            ...(f.line !== undefined ? { region: { startLine: f.line } } : {}),
          },
        },
      ],
      // Provenance (Q04, display-only): each field independently iff present;
      // omitted entirely when both are absent. `message.text` is unchanged.
      ...((f.source !== undefined || f.confidence !== undefined
        ? {
            properties: {
              ...(f.source !== undefined ? { source: f.source } : {}),
              ...(f.confidence !== undefined ? { confidence: f.confidence } : {}),
            },
          }
        : {})),
    }));
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [{ tool: { driver: { name: "pr-reviewer" } }, results }],
  };
}
