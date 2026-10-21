import type { RequestContext } from "../runtime/context.js";
import type { Conversation, ToolCall } from "../agent-types.js";
import type { ResolvedEndpoint } from "../providers.js";
import { redact } from "../domain/text.js";
import type { AgentReply, LlmResult } from "./types.js";
import { PR_REVIEW_SCHEMA, parseContent, parseVerdicts, toFindings, extractUsage } from "./schema.js";
import { isAnthropicCompat, tokenFieldFor, validateSampling } from "./sampling.js";
import { attempt, errMessage, retryDelayMs, waitForRetry, requestTimeout, SNIPPET_CHARS } from "./transport.js";

/** Providers that accept the full strict json_schema shape. */
const FULL_SCHEMA_PROVIDERS: ReadonlySet<string> = new Set(["openai", "opencode-zen", "opencode-go"]);

type ResponseFormat = { type: "json_schema"; json_schema: typeof PR_REVIEW_SCHEMA } | { type: "json_object" };

function responseFormatFor(provider: string): ResponseFormat | undefined {
  if (FULL_SCHEMA_PROVIDERS.has(provider)) return { type: "json_schema", json_schema: PR_REVIEW_SCHEMA };
  if (provider === "anthropic") return undefined;
  return { type: "json_object" };
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
    context?: RequestContext;
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
    if (!await waitForRetry(retryDelayMs(a.retryAfter), o.context)) return requestTimeout();
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
  const u = extractUsage(json, "openai-chat");
  return {
    ok: true,
    findings,
    verdicts: parseVerdicts(parsed),
    ...(u ? { usage: { ...u, calls: 1 } } : {}),
  };
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
    context?: RequestContext;
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
    if (!await waitForRetry(retryDelayMs(a.retryAfter), o.context)) return { ok: false, result: requestTimeout() };
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
  const u = extractUsage(json, "openai-chat");
  return {
    ok: true,
    text: reply.text ?? "",
    toolCalls: reply.toolCalls,
    ...(u ? { usage: { ...u, calls: 1 } } : {}),
  };
}
