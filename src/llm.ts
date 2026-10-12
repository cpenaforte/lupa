import type { Finding } from "./fastpath.js";
import type { Conversation, ToolCall } from "./agent-types.js";
import { PR_REVIEW_SCHEMA } from "./prompt.js";
import { buildEndpointForStyle } from "./providers.js";
import type { ApiStyle, ResolvedApiStyle, ResolvedEndpoint } from "./providers.js";
import { callGoogle, callGoogleTurn } from "./adapters/google.js";
import { callMessages, callMessagesTurn } from "./adapters/messages.js";
import { callResponses, callResponsesTurn } from "./adapters/responses.js";
import { runAgent } from "./agent.js";
import type { ToolContext } from "./agent-tools.js";
import * as core from "@actions/core";

export class InvalidJsonError extends Error {}
export class OllamaMissingError extends Error {}

/** OpenAI reasoning models (strict family, and the max_completion_tokens family). */
const OPENAI_REASONING_RE = /\bo\d|gpt-5|gpt-6/i;
/** Claude version token: major, then an optional 1–2 digit minor not followed by another digit (so dates are never read as minors). */
const CLAUDE_VERSION_RE = /claude[^\d]*(\d+)(?:[.-](\d{1,2})(?!\d))?/i;
/** Providers that accept the full strict json_schema shape. */
const FULL_SCHEMA_PROVIDERS: ReadonlySet<string> = new Set(["openai", "opencode-zen", "opencode-go"]);

const REQUEST_TIMEOUT_HEALTH_MS = 10_000;
const RETRY_BACKOFF_MS = 500;
const MAX_RETRY_AFTER_MS = 5_000;
export const SNIPPET_CHARS = 200;

export type LlmResult =
  | { ok: true; findings: Finding[]; verdicts?: DedupVerdicts }
  | {
      ok: false;
      reason: "no-key" | "unsupported" | "timeout" | "content-filter" | "invalid-json";
      detail: string;
    }
  | {
      ok: false;
      reason: "http-error";
      detail: string;
      /** HTTP status behind the error, when a response existed; drives the style probe. */
      status?: number;
    };

/**
 * A single agent-mode turn reply: the assistant's text plus any tool calls it
 * requested. A failure keeps the single-shot LlmResult union so callers handle
 * both shapes identically. `rawItems` carries adapter-specific raw reply items
 * to echo verbatim on the next turn (unused by the chat adapter).
 */
export type AgentReply =
  | { ok: true; text: string; toolCalls: ToolCall[]; rawItems?: unknown[] }
  | { ok: false; result: LlmResult };

type ResponseFormat = { type: "json_schema"; json_schema: typeof PR_REVIEW_SCHEMA } | { type: "json_object" };

export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * STRICT family (sampling params rejected unless at defaults):
 * OpenAI reasoning models, or Claude major >= 5, or Claude 4.7 and later.
 * Claude 4.0–4.6, Claude 3.x and dated ids are not strict.
 */
function isStrictFamily(model: string): boolean {
  if (OPENAI_REASONING_RE.test(model)) return true;
  const m = CLAUDE_VERSION_RE.exec(model);
  if (m === null) return false;
  const major = Number(m[1]);
  const minor = m[2] === undefined ? 0 : Number(m[2]);
  return major >= 5 || (major === 4 && minor >= 7);
}

function isAnthropicCompat(provider: string, apiStyle?: string): boolean {
  return provider === "anthropic" || apiStyle === "anthropic-messages";
}

export function validateSampling(o: {
  model: string;
  temperature?: number;
  topP?: number;
  n?: number;
  provider: string;
  apiStyle?: string;
}): void {
  const anthropic = isAnthropicCompat(o.provider, o.apiStyle);

  if (isStrictFamily(o.model)) {
    const explicit =
      (o.temperature !== undefined && o.temperature !== 1) ||
      o.topP !== undefined ||
      (o.n !== undefined && o.n !== 1);
    if (explicit) {
      throw new Error(
        anthropic
          ? `Model "${o.model}" is a reasoning model: Anthropic-compat rejects temperature, top_p and n (HTTP 400). Remove them.`
          : `Model "${o.model}" is a reasoning model: temperature, top_p and n must be left at their defaults. Remove them.`,
      );
    }
    return;
  }

  if (anthropic) {
    if (o.n !== undefined && o.n !== 1) {
      throw new Error(`Anthropic-compat supports only n=1; n must be 1 or unset`);
    }
    if (o.temperature !== undefined && o.topP !== undefined) {
      throw new Error(`temperature and top_p cannot be set together on Anthropic-compat`);
    }
    if (o.temperature !== undefined && !(o.temperature >= 0 && o.temperature <= 1)) {
      throw new Error(`temperature must be between 0 and 1`);
    }
    if (o.topP !== undefined && !(o.topP >= 0 && o.topP <= 1)) {
      throw new Error(`top_p must be between 0 and 1`);
    }
  }
}

/** OpenAI reasoning only. Claude always uses max_tokens (Anthropic API). */
export function tokenFieldFor(model: string): "max_completion_tokens" | "max_tokens" {
  return OPENAI_REASONING_RE.test(model) ? "max_completion_tokens" : "max_tokens";
}

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
 * Dedup verdicts carried out-of-band alongside findings (positions stay
 * aligned because every pipeline stage is order-preserving):
 * - `pairs`: sent-list index pairs judged duplicates of each other.
 * - `links`: `[responseIndex, sentIndex]` pointers from model findings
 *   (which restate sent findings via `duplicateOf`) back to sent findings.
 * - `malformed`: count of shape-bad entries dropped at parse.
 */
export interface DedupVerdicts {
  pairs: Array<[number, number]>;
  links: Array<[number, number]>;
  malformed: number;
}

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

/**
 * Hand-written structural check against PR_REVIEW_SCHEMA's required fields.
 * Returns undefined when the response is invalid. Line is coerced rather than
 * rejected: only an integer >= 1 is kept, anything else becomes undefined.
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
    };
    if (Number.isInteger(i.line) && (i.line as number) >= 1) f.line = i.line as number;
    if (typeof i.suggestion === "string") f.suggestion = i.suggestion;
    out.push(f);
  }
  return out;
}

function responseFormatFor(provider: string): ResponseFormat | undefined {
  if (FULL_SCHEMA_PROVIDERS.has(provider)) return { type: "json_schema", json_schema: PR_REVIEW_SCHEMA };
  if (provider === "anthropic") return undefined;
  return { type: "json_object" };
}

// Requires a non-empty key: callLlm's early no-key return guarantees it, and ensureOllama guards
// empty keys in its scrub wrapper, so split("") never runs.
export function redact(text: string, key: string): string {
  return text.split(key).join("[REDACTED]");
}

/**
 * Missing, empty, whitespace-only, non-numeric, or negative Retry-After falls back to the backoff.
 * Values above the cap are clamped to MAX_RETRY_AFTER_MS.
 */
export function retryDelayMs(raw: string | null): number {
  const trimmed = raw?.trim() ?? "";
  if (trimmed === "") return RETRY_BACKOFF_MS;
  const secs = Number(trimmed);
  if (!Number.isFinite(secs) || secs < 0) return RETRY_BACKOFF_MS;
  return Math.min(secs * 1000, MAX_RETRY_AFTER_MS);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type Attempt =
  | { kind: "fail"; result: LlmResult }
  | { kind: "response"; status: number; ok: boolean; retryAfter: string | null; text: string };

/**
 * One HTTP attempt. The abort timer covers the headers AND the body read, and is
 * cleared only after the body is fully read.
 */
export async function attempt(ep: ResolvedEndpoint, payload: string, o: { timeoutSeconds: number; apiKey: string }): Promise<Attempt> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), o.timeoutSeconds * 1000);
  try {
    const res = await fetch(`${ep.baseUrl}${ep.path}`, {
      method: "POST",
      headers: { ...ep.headers, "Content-Type": "application/json" },
      body: payload,
      signal: controller.signal,
    });
    const text = await res.text();
    return { kind: "response", status: res.status, ok: res.ok, retryAfter: res.headers.get("retry-after"), text };
  } catch (e) {
    if (controller.signal.aborted) {
      return { kind: "fail", result: { ok: false, reason: "timeout", detail: `no complete response within ${o.timeoutSeconds}s` } };
    }
    return {
      kind: "fail",
      result: { ok: false, reason: "http-error", detail: redact(`request failed: ${errMessage(e)}`, o.apiKey) },
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Shared chat flags. `allowTools`/`allowFormat` mirror the caller's flags;
 * `anthropic` is the resolved Anthropic-compat bit (that protocol never sends
 * refusals, so the parser must ignore one).
 */
interface ChatFlags {
  allowTools: boolean;
  allowFormat: boolean;
  anthropic: boolean;
}

/** A parsed chat reply: the failure union, or the extracted text + tool calls. */
type ChatReply =
  | { ok: false; result: LlmResult }
  | { ok: true; text: string | undefined; toolCalls: ToolCall[] };

/**
 * Builds the OpenAI-chat request body from a neutral conversation. Shared by
 * the single-shot `callLlm` (no turns, `allowTools:false`) and the agent turn
 * variant: `tools` only when `allowTools`, `response_format` only when
 * `allowFormat` (never on tool turns), sampling only off Anthropic-compat.
 */
function buildChatBody(
  conv: Conversation,
  o: { model: string; temperature?: number; topP?: number; maxTokens: number; provider: string },
  flags: ChatFlags,
): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: conv.system },
    { role: "user", content: conv.user },
  ];
  for (const turn of conv.turns ?? []) {
    if (turn.role === "assistant") {
      messages.push({
        role: "assistant",
        content: turn.text || null,
        tool_calls: turn.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.rawArgs },
        })),
      });
    } else if (turn.role === "tool") {
      messages.push({ role: "tool", tool_call_id: turn.id, content: turn.output });
    } else {
      messages.push({ role: "user", content: turn.text });
    }
  }

  const body: Record<string, unknown> = {
    model: o.model,
    messages,
    [tokenFieldFor(o.model)]: o.maxTokens,
  };
  if (flags.allowTools && conv.tools !== undefined) {
    body.tools = conv.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
  if (flags.allowFormat) {
    const rf = responseFormatFor(o.provider);
    if (rf !== undefined) body.response_format = rf;
  }
  if (!flags.anthropic) {
    if (o.temperature !== undefined) body.temperature = o.temperature;
    if (o.topP !== undefined) body.top_p = o.topP;
  }
  return body;
}

/**
 * Parses an OpenAI-chat reply into the shared failure mappings plus the raw
 * text and tool calls. Tool calls are parsed only when `allowTools` (the
 * single-shot path never expects them). `finish_reason:"tool_calls"` is not
 * special-cased: any finish_reason other than content_filter/length is success.
 */
function parseChatReply(json: unknown, flags: ChatFlags): ChatReply {
  const choice = (json as { choices?: Array<{ finish_reason?: string; message?: Record<string, unknown> }> } | null)
    ?.choices?.[0];
  const msg = choice?.message;

  // Refusal is honored everywhere except Anthropic-compat (which never sends it).
  // A refusal is reported as "content-filter" (the fixed set of failure reasons has no refusal entry).
  if (!flags.anthropic && typeof msg?.refusal === "string" && msg.refusal !== "") {
    return { ok: false, result: { ok: false, reason: "content-filter", detail: "model refused the request" } };
  }
  // Provider content filtering is reported as "content-filter".
  if (choice?.finish_reason === "content_filter") {
    return {
      ok: false,
      result: { ok: false, reason: "content-filter", detail: "provider content filter stopped the response" },
    };
  }
  // The fixed set of failure reasons has no "length" entry: truncation degrades as "invalid-json" (no diff-shrink retry).
  if (choice?.finish_reason === "length") {
    return { ok: false, result: { ok: false, reason: "invalid-json", detail: "response truncated (finish_reason=length)" } };
  }

  const toolCalls: ToolCall[] = [];
  if (flags.allowTools && Array.isArray(msg?.tool_calls)) {
    for (const raw of msg.tool_calls) {
      const tc = (raw ?? {}) as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
      const rawArgs = typeof tc.function?.arguments === "string" ? tc.function.arguments : "";
      let args: unknown;
      try {
        args = JSON.parse(rawArgs);
      } catch {
        // Malformed tool arguments must not throw: the call surfaces args: undefined.
        args = undefined;
      }
      toolCalls.push({
        id: typeof tc.id === "string" ? tc.id : "",
        name: typeof tc.function?.name === "string" ? tc.function.name : "",
        args,
        rawArgs,
      });
    }
  }

  const text = typeof msg?.content === "string" ? msg.content : undefined;
  return { ok: true, text, toolCalls };
}

export async function callLlm(
  ep: ResolvedEndpoint,
  messages: { system: string; user: string },
  o: {
    model: string;
    apiKey: string;
    temperature?: number;
    topP?: number;
    maxTokens: number;
    timeoutSeconds: number;
    provider: string;
  },
): Promise<LlmResult> {
  const key = o.apiKey;
  if (key === "") return { ok: false, reason: "no-key", detail: "no API key configured" };

  const anthropic = isAnthropicCompat(o.provider);
  try {
    validateSampling({ model: o.model, temperature: o.temperature, topP: o.topP, provider: o.provider });
  } catch (e) {
    return { ok: false, reason: "unsupported", detail: redact(errMessage(e), key) };
  }

  const flags: ChatFlags = { allowTools: false, allowFormat: true, anthropic };
  const payload = JSON.stringify(buildChatBody({ system: messages.system, user: messages.user }, o, flags));

  let a = await attempt(ep, payload, o);
  if (a.kind === "fail") return a.result;
  // Retry once on 429 or 5xx only; the delay honors Retry-After (clamped).
  if (a.status === 429 || a.status >= 500) {
    await sleep(retryDelayMs(a.retryAfter));
    a = await attempt(ep, payload, o);
    if (a.kind === "fail") return a.result;
  }

  if (!a.ok) {
    const snippet = redact(a.text, key).slice(0, SNIPPET_CHARS);
    return { ok: false, reason: "http-error", detail: `HTTP ${a.status}${snippet ? `: ${snippet}` : ""}`, status: a.status };
  }

  let json: unknown;
  try {
    json = JSON.parse(a.text);
  } catch {
    return { ok: false, reason: "invalid-json", detail: "response body is not JSON" };
  }
  const reply = parseChatReply(json, flags);
  if (!reply.ok) return reply.result;
  if (typeof reply.text !== "string") {
    return { ok: false, reason: "invalid-json", detail: "response has no content" };
  }

  let parsed: unknown;
  try {
    parsed = parseContent(reply.text);
  } catch (e) {
    return { ok: false, reason: "invalid-json", detail: errMessage(e) };
  }
  const findings = toFindings(parsed);
  if (findings === undefined) {
    return { ok: false, reason: "invalid-json", detail: "response does not match the review schema" };
  }
  return { ok: true, findings, verdicts: parseVerdicts(parsed) };
}

/**
 * Agent-mode turn call on the OpenAI-chat protocol. Same transport, retry and
 * failure mappings as `callLlm`, but translates a neutral conversation (tools
 * + prior turns) into `messages`/`tools` and parses `tool_calls` back. The
 * `flags` gate the tool/format fields: `response_format` is never sent on a
 * tool turn.
 */
export async function callChatTurn(
  ep: ResolvedEndpoint,
  conv: Conversation,
  o: {
    model: string;
    apiKey: string;
    temperature?: number;
    topP?: number;
    maxTokens: number;
    timeoutSeconds: number;
    provider: string;
  },
  flags: { allowTools: boolean; allowFormat: boolean },
): Promise<AgentReply> {
  const key = o.apiKey;
  if (key === "") return { ok: false, result: { ok: false, reason: "no-key", detail: "no API key configured" } };

  const anthropic = isAnthropicCompat(o.provider);
  try {
    validateSampling({ model: o.model, temperature: o.temperature, topP: o.topP, provider: o.provider });
  } catch (e) {
    return { ok: false, result: { ok: false, reason: "unsupported", detail: redact(errMessage(e), key) } };
  }

  const chatFlags: ChatFlags = { allowTools: flags.allowTools, allowFormat: flags.allowFormat, anthropic };
  const payload = JSON.stringify(buildChatBody(conv, o, chatFlags));

  let a = await attempt(ep, payload, o);
  if (a.kind === "fail") return { ok: false, result: a.result };
  // Retry once on 429 or 5xx only; the delay honors Retry-After (clamped).
  if (a.status === 429 || a.status >= 500) {
    await sleep(retryDelayMs(a.retryAfter));
    a = await attempt(ep, payload, o);
    if (a.kind === "fail") return { ok: false, result: a.result };
  }

  if (!a.ok) {
    const snippet = redact(a.text, key).slice(0, SNIPPET_CHARS);
    return {
      ok: false,
      result: { ok: false, reason: "http-error", detail: `HTTP ${a.status}${snippet ? `: ${snippet}` : ""}`, status: a.status },
    };
  }

  let json: unknown;
  try {
    json = JSON.parse(a.text);
  } catch {
    return { ok: false, result: { ok: false, reason: "invalid-json", detail: "response body is not JSON" } };
  }
  const reply = parseChatReply(json, chatFlags);
  if (!reply.ok) return { ok: false, result: reply.result };
  return { ok: true, text: reply.text ?? "", toolCalls: reply.toolCalls };
}

/** Default client timeout for the Ollama pull (pulls can be slow). */
const PULL_TIMEOUT_DEFAULT_S = 300;

/**
 * Dispatches to the adapter of the endpoint's resolved API style: openai-chat
 * keeps callLlm; the v2 styles route to their native-protocol adapters. Same
 * messages/options shape and the same LlmResult union for every style, so
 * callers handle the result identically.
 */
export async function callByStyle(
  ep: ResolvedEndpoint,
  messages: { system: string; user: string },
  o: {
    model: string;
    apiKey: string;
    temperature?: number;
    topP?: number;
    maxTokens: number;
    timeoutSeconds: number;
    provider: string;
  },
): Promise<LlmResult> {
  // No fallback for a missing/malformed apiStyle: resolveEndpoint always sets it,
  // so an endpoint without one is a programming error that should fail loudly.
  switch (ep.apiStyle) {
    case "openai-responses":
      return callResponses(ep, messages, o);
    case "anthropic-messages":
      return callMessages(ep, messages, o);
    case "google-models":
      // Google posts to {base}/models/<id>:generateContent: the model id rides the path.
      return callGoogle(ep, o.model, messages, o);
    case "openai-chat":
      return callLlm(ep, messages, o);
    default:
      // Unreachable by type; guards forged/malformed endpoints at runtime.
      throw new Error("unsupported apiStyle: " + String(ep.apiStyle));
  }
}

// ---------------------------------------------------------------------------
// Error-driven style routing (spec §9.5): no hardcoded (provider,model)->style
// map. `auto` walks the probe order and learns the style from 400/404 errors;
// the catalog GET /models check stays the only existence source of truth.
// Probing is safe by construction: adapters only generate text (read-only,
// idempotent) — they never write.
// ---------------------------------------------------------------------------

/** Probe order for `auto`: chat first (the common case), then the native styles. */
export const PROBE_ORDER = ["openai-chat", "openai-responses", "anthropic-messages", "google-models"] as const;

/** In-process memo of the style that worked, keyed provider:model (session determinism). */
const PROBE_MEMO = new Map<string, ResolvedApiStyle>();

/** Test-only: clears the in-process style memo (production never resets it). */
export function resetProbeMemo(): void {
  PROBE_MEMO.clear();
}

/**
 * Only a 400 or 404 advances the probe (route/contract error: the endpoint or
 * the body shape is wrong for this style). 429/5xx belong to the adapter's own
 * retry; every other outcome (timeout, refusal, content filter, bad JSON, auth
 * error) is not a style signal. The numeric `status` on the http-error result
 * is the contract (set by every adapter); the detail regex stays as a fallback
 * for http-errors emitted without a status.
 */
function isProbeTrigger(result: LlmResult): boolean {
  if (result.ok || result.reason !== "http-error") return false;
  if (result.status !== undefined) return result.status === 400 || result.status === 404;
  return /^HTTP (400|404)(?!\d)/.test(result.detail);
}

export interface ProbeOptions {
  maxTokens: number;
  timeoutSeconds: number;
  temperature?: number;
  topP?: number;
  /** Preserves the opencode-go x-opencode-session header across probe attempts. */
  prNumber?: number | null;
  /**
   * True when the base came from the user's llm_base_url input. Keeps the R3
   * /openai-rewrite warning honest: only a USER-supplied base may trigger it,
   * never the probe's rebuild of a preset-derived base.
   */
  userBase?: boolean;
}

export interface ProbeOutcome {
  result: LlmResult;
  /** The style whose adapter produced the result; set whenever a call was made. */
  via?: ResolvedApiStyle;
}

/**
 * Error-driven routing (spec §9.5). An explicit style is honored as-is: one
 * call, no probe. `auto` (or no style) walks PROBE_ORDER and memoizes the
 * style that worked for the process. A 400/404 advances to the next style and
 * invalidates any memoized style for the pair (contract drift: the probe
 * continues through the remaining styles instead of dead-ending); any other
 * failure is returned as-is. When every tried style answers 400/404 the
 * result is http-error carrying the last (redacted) detail and status, plus a
 * warning naming the model and every style tried.
 */
export async function callWithProbe(
  provider: string,
  model: string,
  baseUrl: string,
  key: string,
  messages: { system: string; user: string },
  o: ProbeOptions,
  explicitStyle?: Exclude<ApiStyle, "custom-path">,
): Promise<ProbeOutcome> {
  if (key === "") {
    return { result: { ok: false, reason: "no-key", detail: "no API key configured" } };
  }

  const callOpts = {
    model,
    apiKey: key,
    temperature: o.temperature,
    topP: o.topP,
    maxTokens: o.maxTokens,
    timeoutSeconds: o.timeoutSeconds,
    provider,
  };

  const run = async (style: ResolvedApiStyle): Promise<ProbeOutcome> => {
    const ep = buildEndpointForStyle(provider, model, baseUrl, key, style, o.prNumber ?? null, o.userBase ?? false);
    return { result: await callByStyle(ep, messages, callOpts), via: style };
  };

  // Explicit style: the user decided; exactly one call, no probe.
  if (explicitStyle !== undefined && explicitStyle !== "auto") {
    return run(explicitStyle);
  }

  const memoKey = `${provider}:${model}`;
  const memoized = PROBE_MEMO.get(memoKey);
  // A stale memo must not dead-end the probe: the memoized style goes first,
  // then every other style in PROBE_ORDER order.
  const order: readonly ResolvedApiStyle[] =
    memoized !== undefined ? [memoized, ...PROBE_ORDER.filter((s) => s !== memoized)] : PROBE_ORDER;

  const attempted: ResolvedApiStyle[] = [];
  let last: LlmResult | undefined;
  for (const style of order) {
    attempted.push(style);
    const out = await run(style);
    if (out.result.ok) {
      PROBE_MEMO.set(memoKey, style);
      return out;
    }
    last = out.result;
    if (!isProbeTrigger(last)) return out;
    // A 400/404 invalidates any memoized style for this pair: drop it and
    // keep probing through the remaining styles.
    PROBE_MEMO.delete(memoKey);
  }

  // Every tried style answered 400/404: report the last failure, name what was tried.
  core.warning(
    `model "${model}": no API style accepted the request; tried ${attempted.join(" → ")}. ` +
      `Set llm_api_style explicitly to skip the probe.`,
  );
  const detail = last !== undefined && !last.ok ? last.detail : "no API style accepted the request";
  const status = last !== undefined && !last.ok && last.reason === "http-error" ? last.status : undefined;
  return {
    result: {
      ok: false,
      reason: "http-error",
      detail: redact(detail, key),
      ...(status !== undefined ? { status } : {}),
    },
    via: attempted.at(-1),
  };
}

// ---------------------------------------------------------------------------
// Agent-mode probe integration: the same error-driven style walk, but each
// style runs the tool loop (runAgent) instead of a single shot. A model that
// rejects tools falls back to single-shot for the rest of the process.
// ---------------------------------------------------------------------------

/** In-process memo of models that reject tools, keyed provider:model. */
const TOOLS_MEMO = new Map<string, boolean>();

/** Test-only: clears the in-process tools memo (production never resets it). */
export function resetToolsMemo(): void {
  TOOLS_MEMO.clear();
}

/**
 * Dispatches one agent turn to the adapter of the endpoint's resolved API
 * style. Same options shape as `callByStyle`; the `flags` gate the
 * tool/format fields exactly like the per-adapter turn calls.
 */
export async function callTurnByStyle(
  ep: ResolvedEndpoint,
  conv: Conversation,
  o: {
    model: string;
    apiKey: string;
    temperature?: number;
    topP?: number;
    maxTokens: number;
    timeoutSeconds: number;
    provider: string;
  },
  flags: { allowTools: boolean; allowFormat: boolean },
): Promise<AgentReply> {
  // No fallback for a missing/malformed apiStyle: resolveEndpoint always sets it,
  // so an endpoint without one is a programming error that should fail loudly.
  switch (ep.apiStyle) {
    case "openai-responses":
      return callResponsesTurn(ep, conv, o, flags);
    case "anthropic-messages":
      return callMessagesTurn(ep, conv, o, flags);
    case "google-models":
      // Google posts to {base}/models/<id>:generateContent: the model id rides the path.
      return callGoogleTurn(ep, o.model, conv, o, flags);
    case "openai-chat":
      return callChatTurn(ep, conv, o, flags);
    default:
      // Unreachable by type; guards forged/malformed endpoints at runtime.
      throw new Error("unsupported apiStyle: " + String(ep.apiStyle));
  }
}

type AgentCallOptions = {
  model: string;
  apiKey: string;
  temperature?: number;
  topP?: number;
  maxTokens: number;
  timeoutSeconds: number;
  provider: string;
  maxTurns: number;
  maxSeconds: number;
};

/**
 * Binds one agent-loop turn to `callTurnByStyle` on a fixed endpoint. The
 * per-turn timeout from the loop overrides the base timeout, mirroring the
 * remaining-budget behavior of the agent runner.
 */
function agentCallFor(ep: ResolvedEndpoint, o: AgentCallOptions) {
  return (
    c: Conversation,
    flags: { allowTools: boolean; allowFormat: boolean },
    callOpts: { timeoutSeconds: number },
  ): Promise<AgentReply> =>
    callTurnByStyle(
      ep,
      c,
      {
        model: o.model,
        apiKey: o.apiKey,
        temperature: o.temperature,
        topP: o.topP,
        maxTokens: o.maxTokens,
        timeoutSeconds: callOpts.timeoutSeconds,
        provider: o.provider,
      },
      flags,
    );
}

/**
 * Runs the agent tool loop against one already-resolved endpoint. The `agent
 * done` summary is logged through runAgent; the loop's final result is
 * returned directly.
 */
export async function callByStyleAgent(
  ep: ResolvedEndpoint,
  conv: Conversation,
  o: AgentCallOptions,
  toolCtx: ToolContext,
): Promise<LlmResult> {
  const outcome = await runAgent(
    conv,
    toolCtx,
    { maxTurns: o.maxTurns, maxSeconds: o.maxSeconds, timeoutSeconds: o.timeoutSeconds },
    { call: agentCallFor(ep, o), log: core.info },
  );
  return outcome.result;
}

/**
 * Agent-mode error-driven routing. Like `callWithProbe` but each style runs
 * the tool loop: an explicit style is honored as-is (one loop, no probe),
 * otherwise the memoized style goes first and a 400/404 advances to the next
 * style. A turn-0 400 that succeeds without tools marks the model as
 * tools-unsupported (single-shot fallback, memoized); a 400 that fails even
 * without tools advances the probe instead — the style itself is wrong, so
 * the advance wins over the tools fallback. Any other outcome is returned
 * as-is. When every tried style fails the result is http-error carrying the
 * last (redacted) detail and status, plus a warning naming the model and
 * every style tried.
 */
export async function callWithProbeAgent(
  provider: string,
  model: string,
  baseUrl: string,
  key: string,
  conv: Conversation,
  o: ProbeOptions & { maxTurns: number; maxSeconds: number },
  toolCtx: ToolContext,
  explicitStyle?: Exclude<ApiStyle, "custom-path">,
): Promise<ProbeOutcome> {
  if (key === "") {
    return { result: { ok: false, reason: "no-key", detail: "no API key configured" } };
  }

  const memoKey = `${provider}:${model}`;

  // A model that already proved it rejects tools skips the loop entirely.
  // The conversation has no turns at this point, so this is single-shot.
  if (TOOLS_MEMO.get(memoKey) === false) {
    core.info("agent tools unsupported for this model: using single-shot");
    return callWithProbe(provider, model, baseUrl, key, { system: conv.system, user: conv.user }, o, explicitStyle);
  }

  const agentOpts: AgentCallOptions = {
    model,
    apiKey: key,
    temperature: o.temperature,
    topP: o.topP,
    maxTokens: o.maxTokens,
    timeoutSeconds: o.timeoutSeconds,
    provider,
    maxTurns: o.maxTurns,
    maxSeconds: o.maxSeconds,
  };

  // One absolute deadline per probe invocation: every probed style shares
  // it instead of restarting the clock (real-clock; the agent loop derives
  // per-call timeouts from it).
  const deadlineMs = Date.now() + o.maxSeconds * 1000;

  const runStyle = async (style: ResolvedApiStyle) => {
    const ep = buildEndpointForStyle(provider, model, baseUrl, key, style, o.prNumber ?? null, o.userBase ?? false);
    const outcome = await runAgent(
      conv,
      toolCtx,
      { maxTurns: o.maxTurns, maxSeconds: o.maxSeconds, timeoutSeconds: o.timeoutSeconds, deadlineMs },
      { call: agentCallFor(ep, agentOpts), log: core.info },
    );
    return { outcome, via: style };
  };

  // Explicit style: the user decided; exactly one loop, no probe.
  if (explicitStyle !== undefined && explicitStyle !== "auto") {
    const { outcome } = await runStyle(explicitStyle);
    return { result: outcome.result, via: explicitStyle };
  }

  // A stale memo must not dead-end the probe: the memoized style goes first,
  // then every other style in PROBE_ORDER order.
  const memoized = PROBE_MEMO.get(memoKey);
  const order: readonly ResolvedApiStyle[] =
    memoized !== undefined ? [memoized, ...PROBE_ORDER.filter((s) => s !== memoized)] : PROBE_ORDER;

  const attempted: ResolvedApiStyle[] = [];
  let last: LlmResult | undefined;
  for (const style of order) {
    attempted.push(style);
    const { outcome } = await runStyle(style);
    last = outcome.result;
    if (outcome.probeAdvance) {
      // A 400/404 invalidates any memoized style for this pair: drop it and
      // keep probing through the remaining styles. This wins over the tools
      // fallback below: a 400 that fails even without tools means the style
      // itself is wrong.
      PROBE_MEMO.delete(memoKey);
      continue;
    }
    if (outcome.toolsUnsupported) {
      // The loop fell back to single-shot: remember it for this model. The
      // result may still be ok (fallback success), so this check must come
      // before the ok branch.
      TOOLS_MEMO.set(memoKey, false);
      return { result: outcome.result, via: style };
    }
    if (outcome.result.ok) {
      PROBE_MEMO.set(memoKey, style);
      return { result: outcome.result, via: style };
    }
    return { result: outcome.result, via: style };
  }

  // Every tried style failed: report the last failure, name what was tried.
  core.warning(
    `model "${model}": no API style accepted the request; tried ${attempted.join(" → ")}. ` +
      `Set llm_api_style explicitly to skip the probe.`,
  );
  const detail = last !== undefined && !last.ok ? last.detail : "no API style accepted the request";
  const status = last !== undefined && !last.ok && last.reason === "http-error" ? last.status : undefined;
  return {
    result: {
      ok: false,
      reason: "http-error",
      detail: redact(detail, key),
      ...(status !== undefined ? { status } : {}),
    },
    via: attempted.at(-1),
  };
}

/**
 * Healthchecks the Ollama server at the root (baseUrl minus trailing /v1),
 * then pulls `model` through the REST API under `timeoutSeconds`. A 404 from
 * pull throws OllamaMissingError. Any apiKey given is redacted from error text.
 */
export async function ensureOllama(
  baseUrl: string,
  model: string,
  o: { timeoutSeconds?: number; apiKey?: string } = {},
): Promise<void> {
  const key = o.apiKey ?? "";
  const timeoutSeconds = o.timeoutSeconds ?? PULL_TIMEOUT_DEFAULT_S;
  // Guarded scrub: an empty key must not reach redact (split("") would interleave markers).
  const scrub = (text: string) => (key === "" ? text : redact(text, key));
  const root = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");

  let health: Response;
  try {
    health = await fetch(`${root}/`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_HEALTH_MS) });
  } catch (e) {
    throw new Error(scrub(`Ollama is not reachable at ${root}: ${errMessage(e)}`));
  }
  await health.text().catch(() => "");
  if (!health.ok) {
    throw new Error(`Ollama is not reachable at ${root} (HTTP ${health.status})`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  let pull: Response;
  let text: string;
  try {
    pull = await fetch(`${root}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, stream: false }),
      signal: controller.signal,
    });
    text = await pull.text();
  } catch (e) {
    if (controller.signal.aborted) {
      throw new Error(`ollama pull "${model}" timed out after ${timeoutSeconds}s`);
    }
    throw new Error(scrub(`ollama pull "${model}" failed: ${errMessage(e)}`));
  } finally {
    clearTimeout(timer);
  }

  if (pull.status === 404) {
    throw new OllamaMissingError(`Ollama model "${model}" is not installed and could not be pulled`);
  }
  if (!pull.ok) {
    throw new Error(`ollama pull "${model}" failed with HTTP ${pull.status}`);
  }
  let body: { error?: unknown } | undefined;
  try {
    body = JSON.parse(text) as { error?: unknown };
  } catch {
    body = undefined;
  }
  if (body?.error) {
    throw new Error(scrub(`ollama pull "${model}" failed: ${String(body.error)}`));
  }
}
