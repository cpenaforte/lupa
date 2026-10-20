import type { Finding } from "../domain/finding.js";
import type { ResolvedApiStyle } from "../providers.js";
import type { DedupVerdicts } from "./types.js";

export class InvalidJsonError extends Error {}

export const PR_REVIEW_SCHEMA = {
  name: "pr_review",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["findings", "duplicates"],
    properties: {
      findings: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["severity", "file", "line", "rule", "message", "suggestion", "duplicateOf", "confidence", "patch"],
          properties: {
            severity: { type: "string", enum: ["info", "warning", "high"] },
            file: { type: "string" },
            line: { type: ["integer", "null"] },
            rule: { type: "string" },
            message: { type: "string" },
            suggestion: { type: ["string", "null"] },
            duplicateOf: { type: ["integer", "null"] },
            confidence: { type: ["integer", "null"] },
            patch: { type: ["string", "null"] },
          },
        },
      },
      duplicates: {
        type: ["array", "null"],
        items: { type: "array", items: { type: "integer" }, minItems: 2, maxItems: 2 },
      },
    },
  },
};

/** Strips a surrounding ```json or bare ``` fence, then parses. */
export function parseContent(raw: string): unknown {
  const stripped = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  try {
    return JSON.parse(stripped);
  } catch {
    throw new InvalidJsonError("model content is not valid JSON");
  }
}

const SEVERITIES: ReadonlySet<unknown> = new Set(["info", "warning", "high"]);

/**
 * Extracts dedup verdicts from the ALREADY-PARSED response object (adapters
 * parse once via `parseContent` — fence handling inherited, no double parse).
 * Shape validation ONLY: drops negative/non-integer indices, self-pairs,
 * non-pairs, and wrong-length pairs (each drop increments `malformed`).
 * Referent checks (unknown sent indices, dangling pointers) belong to the
 * caller holding the arrays — NOT here. Null and absent verdict keys both
 * mean "no verdicts" (never malformed).
 */
export function parseVerdicts(parsed: unknown): DedupVerdicts {
  const verdicts: DedupVerdicts = { pairs: [], links: [], malformed: 0 };
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return verdicts;
  const root = parsed as Record<string, unknown>;
  const dupes = root.duplicates;
  if (dupes === undefined || dupes === null) {
    // No verdicts — normal, not malformed.
  } else if (!Array.isArray(dupes)) {
    verdicts.malformed++;
  } else {
    for (const entry of dupes) {
      if (!Array.isArray(entry) || entry.length !== 2) {
        verdicts.malformed++;
        continue;
      }
      const [a, b] = entry;
      if (!Number.isInteger(a) || (a as number) < 0 || !Number.isInteger(b) || (b as number) < 0 || a === b) {
        verdicts.malformed++;
        continue;
      }
      verdicts.pairs.push([a as number, b as number]);
    }
  }
  const findings = root.findings;
  if (Array.isArray(findings)) {
    for (let i = 0; i < findings.length; i++) {
      const item = findings[i];
      if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
      const target = (item as Record<string, unknown>).duplicateOf;
      if (target === undefined || target === null) continue;
      if (!Number.isInteger(target) || (target as number) < 0) {
        verdicts.malformed++;
        continue;
      }
      verdicts.links.push([i, target as number]);
    }
  }
  return verdicts;
}

/** A finite number >= 0, or undefined (never NaN/Infinity/negative/wrong-typed). */
function nonNegNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/**
 * Pure shape normalization of a provider response body into `{input, output}`
 * per API style (spec §4). Returns undefined for a non-object body, a missing /
 * non-numeric / negative / non-finite field, or a half-shaped usage object —
 * never a partial, NaN or negative result. Counting is the call site's job:
 * each adapter attaches `calls: 1` to the result it produced. Non-object bodies
 * (null, arrays, primitives) yield undefined so adapters never reject on shape.
 */
export function extractUsage(
  body: unknown,
  apiStyle: ResolvedApiStyle,
): { input: number; output: number } | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const root = body as Record<string, unknown>;
  const usage = apiStyle === "google-models" ? root.usageMetadata : root.usage;
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) return undefined;
  const u = usage as Record<string, unknown>;

  switch (apiStyle) {
    case "openai-chat": {
      const input = nonNegNumber(u.prompt_tokens);
      const output = nonNegNumber(u.completion_tokens);
      return input === undefined || output === undefined ? undefined : { input, output };
    }
    case "openai-responses": {
      const input = nonNegNumber(u.input_tokens);
      const output = nonNegNumber(u.output_tokens);
      return input === undefined || output === undefined ? undefined : { input, output };
    }
    case "anthropic-messages": {
      // input_tokens is required (caches alone do not form an input); the cache
      // counters are billed input, so they fold in. Wrong-typed caches count as
      // 0, never concatenated.
      const input = nonNegNumber(u.input_tokens);
      const output = nonNegNumber(u.output_tokens);
      if (input === undefined || output === undefined) return undefined;
      const cacheRead = nonNegNumber(u.cache_read_input_tokens) ?? 0;
      const cacheCreation = nonNegNumber(u.cache_creation_input_tokens) ?? 0;
      return { input: input + cacheRead + cacheCreation, output };
    }
    case "google-models": {
      // promptTokenCount already includes cached tokens: no addition. Output is
      // total−prompt when both are present (a negative derivation is absent),
      // else candidatesTokenCount.
      const input = nonNegNumber(u.promptTokenCount);
      if (input === undefined) return undefined;
      const total = nonNegNumber(u.totalTokenCount);
      if (total !== undefined) {
        const derived = total - input;
        return derived >= 0 ? { input, output: derived } : undefined;
      }
      const candidates = nonNegNumber(u.candidatesTokenCount);
      return candidates === undefined ? undefined : { input, output: candidates };
    }
  }
}

/**
 * Hand-written structural check against PR_REVIEW_SCHEMA's required fields.
 * Returns undefined when the response is invalid. Line is coerced rather than
 * rejected: only an integer >= 1 is kept, anything else becomes undefined.
 * Single-shot provenance (Q04): every finding gains `source: "llm"`; a
 * safe-integer 0..100 `confidence` is carried, anything else drops the FIELD
 * (never the finding — verdict-index alignment is preserved). A string `patch`
 * is carried verbatim; a wrong-typed one drops the field the same way.
 */
export function toFindings(v: unknown): Finding[] | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const list = (v as { findings?: unknown }).findings;
  if (!Array.isArray(list)) return undefined;
  const out: Finding[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) return undefined;
    const i = item as Record<string, unknown>;
    if (!SEVERITIES.has(i.severity)) return undefined;
    if (typeof i.file !== "string" || typeof i.rule !== "string" || typeof i.message !== "string") return undefined;
    if (!(i.suggestion === null || typeof i.suggestion === "string")) return undefined;
    const f: Finding = {
      severity: i.severity as Finding["severity"],
      file: i.file,
      rule: i.rule,
      message: i.message,
      source: "llm",
    };
    if (Number.isInteger(i.line) && (i.line as number) >= 1) f.line = i.line as number;
    if (typeof i.suggestion === "string") f.suggestion = i.suggestion;
    // Wrong-typed patch drops the FIELD only (confidence precedent): a single
    // malformed patch must never discard the whole review — positions stay
    // untouched, so verdict-index alignment holds.
    if (typeof i.patch === "string") f.patch = i.patch;
    if (
      typeof i.confidence === "number" &&
      Number.isSafeInteger(i.confidence) &&
      i.confidence >= 0 &&
      i.confidence <= 100
    ) {
      f.confidence = i.confidence;
    }
    out.push(f);
  }
  return out;
}
