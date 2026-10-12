import type { ResolvedEndpoint } from "../providers.js";
import type { Conversation, ToolCall } from "../agent-types.js";
import {
  attempt,
  errMessage,
  parseContent,
  parseVerdicts,
  redact,
  retryDelayMs,
  sleep,
  toFindings,
  validateSampling,
  SNIPPET_CHARS,
  type AgentReply,
  type LlmResult,
} from "../llm.js";

/** Concatenates `text` blocks from the response's `content[]` array. */
function joinContentText(json: unknown): string | undefined {
  const content = (json as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return undefined;
  const texts: string[] = [];
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const p = part as { type?: unknown; text?: unknown };
    if (p.type === "text" && typeof p.text === "string") texts.push(p.text);
  }
  return texts.length > 0 ? texts.join("") : undefined;
}

/**
 * Shared messages flags. `allowTools` mirrors the caller's flag; `allowFormat`
 * is a no-op here (this protocol has no structured-output format), pinned so a
 * future caller can never accidentally emit a format field.
 */
interface MessagesFlags {
  allowTools: boolean;
  allowFormat: boolean;
}

/** A parsed messages reply: the failure union, or the extracted text + tool calls. */
type MessagesReply =
  | { ok: false; result: LlmResult }
  | { ok: true; text: string | undefined; toolCalls: ToolCall[]; rawItems: unknown[] };

/**
 * Builds the Anthropic Messages request body from a neutral conversation. Shared
 * by the single-shot `callMessages` (no turns, `allowTools:false`) and the agent
 * turn variant: `tools` only when `allowTools` (as `input_schema`); there is no
 * `response_format` on this protocol, so `allowFormat` never adds a field.
 * Consecutive tool-result turns collapse into ONE user message (the API wants
 * every `tool_result` block for a parallel call set in a single user turn).
 */
function buildMessagesBody(
  conv: Conversation,
  o: { model: string; temperature?: number; topP?: number; maxTokens: number },
  flags: MessagesFlags,
): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [{ role: "user", content: conv.user }];
  let pendingResults: Array<Record<string, unknown>> = [];
  const flushResults = (): void => {
    if (pendingResults.length > 0) {
      messages.push({ role: "user", content: pendingResults });
      pendingResults = [];
    }
  };
  for (const turn of conv.turns ?? []) {
    if (turn.role === "assistant") {
      flushResults();
      if (turn.rawItems !== undefined) {
        messages.push({ role: "assistant", content: turn.rawItems });
        continue;
      }
      const content: Array<Record<string, unknown>> = [];
      if (turn.text) content.push({ type: "text", text: turn.text });
      for (const tc of turn.toolCalls) {
        content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args ?? {} });
      }
      messages.push({ role: "assistant", content });
    } else if (turn.role === "tool") {
      pendingResults.push({
        type: "tool_result",
        tool_use_id: turn.id,
        content: turn.output,
        ...(turn.isError ? { is_error: true } : {}),
      });
    } else {
      flushResults();
      messages.push({ role: "user", content: [{ type: "text", text: turn.text }] });
    }
  }
  flushResults();

  const body: Record<string, unknown> = {
    model: o.model,
    // max_tokens is REQUIRED on every /messages call, including reasoning models.
    max_tokens: o.maxTokens,
    system: conv.system,
    messages,
  };
  if (flags.allowTools && conv.tools !== undefined) {
    body.tools = conv.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }
  if (o.temperature !== undefined) body.temperature = o.temperature;
  if (o.topP !== undefined) body.top_p = o.topP;
  return body;
}

/**
 * Parses a Messages reply into the shared failure mappings plus the raw text and
 * tool calls. Refusal reads as content-filter; max_tokens degrades as
 * "invalid-json" (no diff-shrink retry). Tool calls (`type:"tool_use"`) are
 * parsed only when `allowTools`; `stop_reason:"tool_use"` is not special-cased —
 * it is success like any other non-refusal/non-max_tokens stop.
 */
function parseMessagesReply(json: unknown, flags: MessagesFlags): MessagesReply {
  const stopReason = (json as { stop_reason?: unknown } | null)?.stop_reason;
  // Refusal is honored natively here (the fixed set of failure reasons has no refusal entry).
  if (stopReason === "refusal") {
    return { ok: false, result: { ok: false, reason: "content-filter", detail: "model refused the request" } };
  }
  // The fixed set of failure reasons has no "length" entry: truncation degrades as "invalid-json" (no diff-shrink retry).
  if (stopReason === "max_tokens") {
    return {
      ok: false,
      result: { ok: false, reason: "invalid-json", detail: "response truncated (stop_reason=max_tokens)" },
    };
  }

  const toolCalls: ToolCall[] = [];
  const content = (json as { content?: unknown } | null)?.content;
  if (flags.allowTools && Array.isArray(content)) {
    for (const part of content) {
      if (typeof part !== "object" || part === null) continue;
      const p = part as { type?: unknown; id?: unknown; name?: unknown; input?: unknown };
      if (p.type !== "tool_use") continue;
      const input = p.input;
      toolCalls.push({
        id: typeof p.id === "string" ? p.id : "",
        name: typeof p.name === "string" ? p.name : "",
        args: input,
        rawArgs: JSON.stringify(input ?? {}),
      });
    }
  }

  return { ok: true, text: joinContentText(json), toolCalls, rawItems: Array.isArray(content) ? content : [] };
}

/**
 * Anthropic Messages API (`POST {base}/messages`): `{model, max_tokens, system,
 * messages}` in, `content[]` out. Auth is `x-api-key` + `anthropic-version`
 * (never `Authorization`); sampling params are never sent by default (Claude
 * 4.7+ rejects them), `stop_reason` maps refusal→content-filter and
 * max_tokens→degrade, and there is no structured-output format to fall back from.
 */
export async function callMessages(
  ep: ResolvedEndpoint,
  messages: { system: string; user: string },
  o: {
    model: string;
    apiKey: string;
    temperature?: number;
    topP?: number;
    maxTokens: number;
    timeoutSeconds: number;
  },
): Promise<LlmResult> {
  const key = o.apiKey;
  if (key === "") return { ok: false, reason: "no-key", detail: "no API key configured" };

  try {
    // Hardcoded "anthropic": like callResponses, the signature carries no provider — the
    // Anthropic-compat sampling rules only need the anthropic family check.
    validateSampling({ model: o.model, temperature: o.temperature, topP: o.topP, provider: "anthropic" });
  } catch (e) {
    return { ok: false, reason: "unsupported", detail: redact(errMessage(e), key) };
  }

  // NEVER temperature/top_p/n/response_format by default: like openai-responses, only
  // explicitly configured sampling rides along (post-validateSampling); n and
  // response_format are never sent.
  const flags: MessagesFlags = { allowTools: false, allowFormat: false };
  const payload = JSON.stringify(buildMessagesBody({ system: messages.system, user: messages.user }, o, flags));

  // Spec §9.2 auth: x-api-key + anthropic-version; the endpoint only lends its
  // User-Agent/session headers (Authorization is not part of this protocol).
  const headers: Record<string, string> = {
    ...ep.headers,
    "x-api-key": key,
    "anthropic-version": "2023-06-01",
  };
  // Case-insensitive strip: Authorization is not part of this protocol, whatever its casing.
  for (const k of Object.keys(headers)) {
    if (/^authorization$/i.test(k)) delete headers[k];
  }
  const authEp: ResolvedEndpoint = { baseUrl: ep.baseUrl, path: ep.path, headers, apiStyle: ep.apiStyle };

  let a = await attempt(authEp, payload, o);
  if (a.kind === "fail") return a.result;
  // Retry once on 429 or 5xx only; the delay honors Retry-After (clamped).
  if (a.status === 429 || a.status >= 500) {
    await sleep(retryDelayMs(a.retryAfter));
    a = await attempt(authEp, payload, o);
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

  const reply = parseMessagesReply(json, flags);
  if (!reply.ok) return reply.result;
  const text = reply.text;
  if (text === undefined) {
    return { ok: false, reason: "invalid-json", detail: "response has no content" };
  }

  let parsed: unknown;
  try {
    parsed = parseContent(text);
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
 * Agent-mode turn call on the Anthropic Messages protocol. Same transport, retry
 * and failure mappings as `callMessages`, but translates a neutral conversation
 * (tools + prior turns) into `messages`/`tools` (as `input_schema`) and parses
 * `tool_use` content blocks back. The `flags` gate the tool field; `allowFormat`
 * is a no-op (this protocol has no structured-output format).
 */
export async function callMessagesTurn(
  ep: ResolvedEndpoint,
  conv: Conversation,
  o: {
    model: string;
    apiKey: string;
    temperature?: number;
    topP?: number;
    maxTokens: number;
    timeoutSeconds: number;
  },
  flags: { allowTools: boolean; allowFormat: boolean },
): Promise<AgentReply> {
  const key = o.apiKey;
  if (key === "") return { ok: false, result: { ok: false, reason: "no-key", detail: "no API key configured" } };

  try {
    validateSampling({ model: o.model, temperature: o.temperature, topP: o.topP, provider: "anthropic" });
  } catch (e) {
    return { ok: false, result: { ok: false, reason: "unsupported", detail: redact(errMessage(e), key) } };
  }

  const mFlags: MessagesFlags = { allowTools: flags.allowTools, allowFormat: flags.allowFormat };
  const payload = JSON.stringify(buildMessagesBody(conv, o, mFlags));

  // Spec §9.2 auth: x-api-key + anthropic-version; the endpoint only lends its
  // User-Agent/session headers (Authorization is not part of this protocol).
  const headers: Record<string, string> = {
    ...ep.headers,
    "x-api-key": key,
    "anthropic-version": "2023-06-01",
  };
  // Case-insensitive strip: Authorization is not part of this protocol, whatever its casing.
  for (const k of Object.keys(headers)) {
    if (/^authorization$/i.test(k)) delete headers[k];
  }
  const authEp: ResolvedEndpoint = { baseUrl: ep.baseUrl, path: ep.path, headers, apiStyle: ep.apiStyle };

  let a = await attempt(authEp, payload, o);
  if (a.kind === "fail") return { ok: false, result: a.result };
  // Retry once on 429 or 5xx only; the delay honors Retry-After (clamped).
  if (a.status === 429 || a.status >= 500) {
    await sleep(retryDelayMs(a.retryAfter));
    a = await attempt(authEp, payload, o);
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
  const reply = parseMessagesReply(json, mFlags);
  if (!reply.ok) return { ok: false, result: reply.result };
  return { ok: true, text: reply.text ?? "", toolCalls: reply.toolCalls, rawItems: reply.rawItems };
}
