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

// Requires a non-empty key: callLlm's early no-key return guarantees it, and ensureOllama guards
// empty keys in its scrub wrapper, so split("") never runs.
export function redact(text: string, key: string): string {
  return text.split(key).join("[REDACTED]");
}
