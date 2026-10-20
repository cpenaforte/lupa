import type { Finding } from "../domain/finding.js";
import type { FileDiff, HunkLine, ParsedHunk } from "../domain/diff.js";
import type { FailLevel } from "../inputs.js";


function keyOf(side: "LEFT" | "RIGHT", line: number): string {
  return `${side}:${line}`;
}

export function isValidLine(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1;
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
export function hunkHit(index: Map<string, Map<string, HunkLine>>, file: string, line: number): HunkLine | undefined {
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
  threads: import("../github.js").ReviewThread[],
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
