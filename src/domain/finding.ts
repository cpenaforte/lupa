import { capText, MSG_CAP, RULE_CAP } from "./text.js";

export interface ChangeAnchor {
  file: string;
  line: number;
  side: "LEFT" | "RIGHT";
}

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
  /** Causal claim in the bound patch, independent of the display location. */
  change?: ChangeAnchor;
  /** A supplied claim was malformed or lost its exact identity. Never grants eligibility. */
  changeInvalid?: true;
}

const SUGGESTION_CAP = 4000;
const FILE_CAP = 200;

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

/** C0 and DEL controls except TAB and LF (kept for multi-line messages and suggestions). */
const CONTROL_KEEP_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
/** Every C0 and DEL control, for single-line fields (file, rule). */
const CONTROL_ALL = /[\u0000-\u001f\u007f]/g;

/** Absolute, drive-qualified, or parent-traversing paths are never placed on a diff line. */
export function unsafePath(file: string): boolean {
  return (
    file.startsWith("/") ||
    file.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/.test(file) ||
    file.split(/[\\/]/).includes("..")
  );
}

/** An exact, representable claim. Do not normalize paths into different identities. */
export function isChangeAnchor(value: unknown): value is ChangeAnchor {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const c = value as Record<string, unknown>;
  return Object.keys(c).length === 3 && typeof c.file === "string" && c.file.length > 0 &&
    Array.from(c.file).length <= FILE_CAP && !unsafePath(c.file) && !/[\u0000-\u001f\u007f]/.test(c.file) &&
    typeof c.line === "number" && Number.isSafeInteger(c.line) && c.line >= 1 &&
    (c.side === "LEFT" || c.side === "RIGHT");
}

/** Keep invalid claims distinguishable from absent legacy input across every boundary. */
export function changeClaim(change: unknown, invalid?: unknown): Pick<Finding, "change" | "changeInvalid"> {
  if (invalid === true) return { changeInvalid: true };
  if (change === undefined || change === null) return {};
  if (!isChangeAnchor(change)) return { changeInvalid: true };
  return { change: { file: change.file, line: change.line, side: change.side } };
}

/**
 * Strips control characters, caps lengths, and turns unsafe paths into repository-level notes
 * (general body). Unsafe-path check runs after the control strip, before the length cap.
 *
 * Paths longer than FILE_CAP (200 chars) are intentionally capped and then fall back to general
 * notes: a truncated path matches no diff line, so mapToComments never places it inline.
 */
export function sanitizeFinding(f: Finding): Finding {
  let file = f.file.replace(CONTROL_ALL, "");
  let message = f.message.replace(CONTROL_KEEP_TEXT, "");
  let line = f.line;
  if (file !== "" && unsafePath(file)) {
    message = `artifact path rejected: ${message}`;
    file = "";
    line = undefined;
  }
  const out: Finding = {
    severity: f.severity,
    file: capText(file, FILE_CAP),
    rule: capText(f.rule.replace(CONTROL_ALL, ""), RULE_CAP),
    message: capText(message, MSG_CAP),
    ...changeClaim(f.change, f.changeInvalid),
  };
  if (line !== undefined) out.line = line;
  if (f.suggestion !== undefined) {
    out.suggestion = capText(f.suggestion.replace(CONTROL_KEEP_TEXT, ""), SUGGESTION_CAP);
  }
  if (f.patch !== undefined) {
    out.patch = capText(f.patch.replace(CONTROL_KEEP_TEXT, ""), SUGGESTION_CAP);
  }
  if (f.source !== undefined) {
    const stripped = f.source.replace(CONTROL_ALL, "");
    if (stripped !== "") out.source = capText(stripped, RULE_CAP);
  }
  if (f.confidence !== undefined) out.confidence = f.confidence;
  if (f.evidence !== undefined) {
    const evidence: NonNullable<Finding["evidence"]> = {};
    if (f.evidence.analyzer !== undefined) {
      evidence.analyzer = capText(f.evidence.analyzer.replace(CONTROL_ALL, ""), RULE_CAP);
    }
    if (f.evidence.snippet !== undefined) {
      evidence.snippet = capText(f.evidence.snippet.replace(CONTROL_KEEP_TEXT, ""), MSG_CAP);
    }
    out.evidence = evidence;
  }
  return out;
}
