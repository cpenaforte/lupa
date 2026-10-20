import type { Finding } from "../domain/finding.js";
import { MSG_CAP, RULE_CAP, capText } from "../domain/text.js";
import type { DedupVerdicts } from "../llm/types.js";
import { hasPatch } from "./limits.js";


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
export interface FindingGroup {
  finding: Finding;
  members: readonly number[];
}

export function groupFindings(
  findings: Finding[],
  verdicts: DedupVerdicts,
): { groups: FindingGroup[]; dropped: number } {
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
  return {
    groups: ordered.map((members) => ({ members, finding: members.length === 1 ? findings[members[0]!]! : survivor(members.map((i) => findings[i]!)) })),
    dropped,
  };
}

/** Compatibility projection; policy uses the original members instead. */
export function mergeDuplicates(findings: Finding[], verdicts: DedupVerdicts): { merged: Finding[]; dropped: number } {
  const { groups, dropped } = groupFindings(findings, verdicts);
  return { merged: groups.map((g) => g.finding), dropped };
}
