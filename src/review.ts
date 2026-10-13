import type { Finding } from "./fastpath.js";
import { MSG_CAP, RULE_CAP, TRUNC_MARK, capText } from "./fastpath.js";
import type { FailLevel } from "./inputs.js";
import type { DedupVerdicts } from "./llm.js";
import type { FileDiff, HunkLine, ParsedHunk } from "./diff.js";
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
  /**
   * Finding rule, set by mapToComments for fold keys. INTERNAL: main.ts strips
   * it when building payload.comments, so posted payloads keep today's shape.
   * Absent (e.g. hand-built comments) means assume blocking in fold marking.
   */
  rule?: string;
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
 * The single gate for every patch rendering site (Q01): a patch fences/renders
 * **iff** its stored (sanitized) value is a non-empty, non-whitespace-only
 * string that was NOT capped. The trim lives ONLY in this test — the stored and
 * rendered value stays verbatim. A value ending in TRUNC_MARK was capped by
 * `sanitizeFinding`, so it is advice-only and never fenced.
 */
export function hasPatch(f: Finding): f is Finding & { patch: string } {
  return typeof f.patch === "string" && f.patch.trim() !== "" && !f.patch.endsWith(TRUNC_MARK);
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
 * appended after the message/suggestion — AFTER any suggestion fence or
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
 * Hunk index shared by display (mapToComments) and gating (partitionGate).
 * First-write-wins per file+side+line, matching the original inline logic.
 */
export function indexHunks(hunks: ParsedHunk[]): Map<string, Map<string, HunkLine>> {
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
  return index;
}

/**
 * Display hit: RIGHT wins deterministically (findings reference new-file line
 * numbers); LEFT is the fallback. Undefined for fileless findings and lines
 * with no hunk entry.
 */
function hunkHit(index: Map<string, Map<string, HunkLine>>, file: string, line: number): HunkLine | undefined {
  const byKey = file === "" ? undefined : index.get(file);
  if (byKey === undefined) return undefined;
  return byKey.get(keyOf("RIGHT", line)) ?? byKey.get(keyOf("LEFT", line));
}

/** Stable identity for thread matching: rule, file, line joined by NUL. */
export function reopenedKey(f: Finding): string {
  return `${f.rule}\0${f.file}\0${String(f.line)}`;
}

/**
 * Normalizes a login across both API conventions: strips one trailing `[bot]`.
 * Compared on both sides, so `x[bot]` and `x` are identical.
 */
export function normalizeBot(login: string): string {
  return login.endsWith("[bot]") ? login.slice(0, -"[bot]".length) : login;
}

/**
 * Pure reopen match over the MERGED set, in ANY position: a resolved thread whose
 * line drifted to context/LEFT must still re-block while the issue persists.
 * Keeps a thread iff it is resolved, its author normalizes to the review actor
 * (null authors never match), and its rule INTERSECTS the finding's rule
 * (`+`-split on both sides — the posted thread rule is the joined survivor while
 * the next run may see unmerged members). File is exact; the thread line is
 * `line ?? originalLine` (both absent → no match). Returns the reopened keys.
 */
export function resolveReopened(
  findings: Finding[],
  threads: import("./github.js").ReviewThread[],
  selfLogin: string,
): Set<string> {
  const self = normalizeBot(selfLogin);
  const kept = threads.filter(
    (t) =>
      t.isResolved &&
      t.rule !== null &&
      t.authorLogin !== null &&
      normalizeBot(t.authorLogin) === self &&
      (t.line ?? t.originalLine ?? null) !== null,
  );
  const out = new Set<string>();
  for (const f of findings) {
    if (typeof f.line !== "number") continue;
    const rules = new Set(f.rule.split("+"));
    for (const t of kept) {
      if (t.path !== f.file) continue;
      if ((t.line ?? t.originalLine) !== f.line) continue;
      const threadRules = (t.rule as string).split("+");
      if (threadRules.some((r) => rules.has(r))) {
        out.add(reopenedKey(f));
        break;
      }
    }
  }
  return out;
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
 *
 * Each inline comment carries the finding's rule for fold keys (INTERNAL: stripped
 * before posting, so payload shapes are unchanged). Items whose key is in
 * `reopened` render the `**reopened**` marker via formatBody.
 */
export function mapToComments(
  findings: Finding[],
  hunks: ParsedHunk[],
  reopened?: ReadonlySet<string>,
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
    inline.push({ path: f.file, line, side: hit.side, body: formatBody(f, hit.side, isReopened), rule: f.rule });
  }
  return { inline, general };
}

/**
 * Gate partition over the merged set (input order preserved in both outputs).
 * Introduced = TOUCHED lines only: a lined finding whose file+line hits a
 * RIGHT-side hunk line with kind "add" (context and LEFT/deletion hits keep
 * their inline display but never gate), plus lineless findings whose file is
 * present in the diff (FileDiff entry not marked deleted, with empty hunks
 * text or an add line for the file — added-empty, mode-only, rename and
 * added-binary count; deleted and pure-removal files do not; "" never
 * matches). Everything else is general. Placement ≠ blocking: the display
 * split (mapToComments) is untouched.
 */
export function partitionGate(
  findings: Finding[],
  hunks: ParsedHunk[],
  files: FileDiff[],
): { introduced: Finding[]; general: Finding[] } {
  const index = indexHunks(hunks);
  const addFiles = new Set<string>();
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.kind === "add") {
        addFiles.add(h.file);
        break;
      }
    }
  }
  const present = new Map<string, FileDiff>();
  for (const f of files) {
    if (!present.has(f.file)) present.set(f.file, f);
  }
  const introduced: Finding[] = [];
  const general: Finding[] = [];
  for (const f of findings) {
    if (isValidLine(f.line)) {
      const hit = hunkHit(index, f.file, f.line);
      if (hit !== undefined && hit.side === "RIGHT" && hit.kind === "add") introduced.push(f);
      else general.push(f);
      continue;
    }
    if (f.file === "") {
      general.push(f);
      continue;
    }
    const entry = present.get(f.file);
    if (entry === undefined || entry.deleted === true) {
      general.push(f);
      continue;
    }
    if (entry.hunks === "" || addFiles.has(f.file)) introduced.push(f);
    else general.push(f);
  }
  return { introduced, general };
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

// ---------------------------------------------------------------------------
// Deterministic dedup merge. The LLM judges duplicate pairs; this function
// merges them with visible, testable rules. All indices are absolute (pairs
// are sent indices into the kept fast-list prefix, links were converted at
// the slowPath boundary) — the merge performs no offset arithmetic.
// ---------------------------------------------------------------------------

const MERGE_SEVERITY_RANK: Record<Finding["severity"], number> = { info: 0, warning: 1, high: 2 };

/**
 * Same-location precondition: members must share `file`, and lines must be
 * both-undefined or equal. Tested PER PAIR/LINK before closure, so one wrong
 * model pair can never swallow an unrelated location.
 */
function mergeable(a: Finding, b: Finding): boolean {
  if (a.file !== b.file) return false;
  if (a.line === undefined || b.line === undefined) return a.line === undefined && b.line === undefined;
  return a.line === b.line;
}

/** Survivor for one group, members in position order (first-member-position order overall). */
function survivor(members: Finding[]): Finding {
  const first = members[0]!;
  let line: number | undefined;
  for (const m of members) {
    if (m.line !== undefined) {
      line = m.line;
      break;
    }
  }
  const rules: string[] = [];
  for (const m of members) if (!rules.includes(m.rule)) rules.push(m.rule);
  let severity = first.severity;
  for (const m of members) {
    if (MERGE_SEVERITY_RANK[m.severity] > MERGE_SEVERITY_RANK[severity]) severity = m.severity;
  }
  const out: Finding = {
    severity,
    file: first.file,
    rule: capText(rules.join("+"), RULE_CAP),
    message: capText(
      members.map((m) => `[${m.rule}] ${m.message}`).join("\n\n"),
      MSG_CAP,
    ),
  };
  if (line !== undefined) out.line = line;
  for (const m of members) {
    if (m.suggestion !== undefined) {
      out.suggestion = m.suggestion;
      break;
    }
  }
  // Patch (Q01): the first member satisfying hasPatch wins; absent iff none
  // (stricter than suggestion: a whitespace-only patch never shadows a valid
  // later one).
  for (const m of members) {
    if (hasPatch(m)) {
      out.patch = m.patch;
      break;
    }
  }
  // Provenance (Q04, display-only): sources "+"-joined in group order
  // (collapse identical, re-capped at 100, absent iff all members absent);
  // confidence is the max (absent iff all members absent); evidence merges
  // the first defined snippet with the distinct present analyzers "+"-joined
  // and re-capped at 100 (absent when no member defines any evidence field,
  // never an empty object).
  const sources: string[] = [];
  for (const m of members) {
    if (m.source !== undefined && !sources.includes(m.source)) sources.push(m.source);
  }
  if (sources.length > 0) out.source = capText(sources.join("+"), RULE_CAP);
  let confidence: number | undefined;
  for (const m of members) {
    if (m.confidence !== undefined && (confidence === undefined || m.confidence > confidence)) {
      confidence = m.confidence;
    }
  }
  if (confidence !== undefined) out.confidence = confidence;
  let snippet: string | undefined;
  const analyzers: string[] = [];
  for (const m of members) {
    if (m.evidence === undefined) continue;
    if (snippet === undefined && m.evidence.snippet !== undefined) snippet = m.evidence.snippet;
    if (m.evidence.analyzer !== undefined && !analyzers.includes(m.evidence.analyzer)) {
      analyzers.push(m.evidence.analyzer);
    }
  }
  if (snippet !== undefined || analyzers.length > 0) {
    out.evidence = {
      ...(analyzers.length > 0 ? { analyzer: capText(analyzers.join("+"), RULE_CAP) } : {}),
      ...(snippet !== undefined ? { snippet } : {}),
    };
  }
  return out;
}

/**
 * Merges findings judged duplicates by `verdicts`. Check-then-union order:
 * each pair/link is precondition-tested before it unions, then groups close
 * transitively over the valid edges only. Partially-valid pairs drop whole;
 * unmergeable entries (precondition failures, out-of-range indices) are
 * counted in `dropped` — every finding is still represented exactly once in
 * `merged`, so the worst case is duplicates staying.
 */
export function mergeDuplicates(
  findings: Finding[],
  verdicts: DedupVerdicts,
): { merged: Finding[]; dropped: number } {
  const parent = findings.map((_, i) => i);
  const root = (x: number): number => (parent[x] === x ? x : (parent[x] = root(parent[x]!)));
  let dropped = 0;
  const consider = (a: number, b: number): void => {
    if (!Number.isInteger(a) || !Number.isInteger(b)) {
      dropped += 1;
      return;
    }
    const fa = findings[a];
    const fb = findings[b];
    if (fa === undefined || fb === undefined || !mergeable(fa, fb)) {
      dropped += 1;
      return;
    }
    const ra = root(a);
    const rb = root(b);
    if (ra !== rb) parent[rb] = ra;
  };
  for (const [a, b] of verdicts.pairs) consider(a, b);
  for (const [a, b] of verdicts.links) consider(a, b);
  const groups = new Map<number, number[]>();
  for (let i = 0; i < findings.length; i++) {
    const r = root(i);
    const g = groups.get(r);
    if (g === undefined) groups.set(r, [i]);
    else g.push(i);
  }
  const ordered = [...groups.values()].sort((x, y) => x[0]! - y[0]!);
  const merged = ordered.map((members) =>
    members.length === 1 ? findings[members[0]!]! : survivor(members.map((i) => findings[i]!)),
  );
  return { merged, dropped };
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
