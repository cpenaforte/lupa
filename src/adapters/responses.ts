import { PR_REVIEW_SCHEMA } from "../prompt.js";
import type { ResolvedEndpoint } from "../providers.js";
import type { Conversation, ToolCall } from "../agent-types.js";
import {
  attempt,
  errMessage,
  parseContent,
  redact,
  retryDelayMs,
  sleep,
  toFindings,
  validateSampling,
  SNIPPET_CHARS,
  type AgentReply,
  type LlmResult,
} from "../llm.js";

/** Every `{type, ...}` block inside `output[].content[]`. */
function outputParts(json: unknown): Array<Record<string, unknown>> {
  const output = (json as { output?: unknown } | null)?.output;
  if (!Array.isArray(output)) return [];
  const parts: Array<Record<string, unknown>> = [];
  for (const item of output) {
    const content = (item as { content?: unknown } | null)?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (typeof part === "object" && part !== null) parts.push(part as Record<string, unknown>);
    }
  }
  return parts;
}

function hasRefusal(json: unknown): boolean {
  return outputParts(json).some(
    (p) => p.type === "refusal" && typeof p.refusal === "string" && p.refusal !== "",
  );
}

/** Joins `output_text` (or plain `text`) parts across all output items. */
function joinOutputText(json: unknown): string | undefined {
  const texts = outputParts(json)
    .filter((p) => (p.type === "output_text" || p.type === "text") && typeof p.text === "string")
    .map((p) => p.text as string);
  return texts.length > 0 ? texts.join("") : undefined;
}

/** Shared responses flags. `allowTools`/`allowFormat` mirror the caller's flags. */
interface ResponsesFlags {
  allowTools: boolean;
  allowFormat: boolean;
}

/** A parsed responses reply: the failure union, or the extracted text + tool calls. */
type ResponsesReply =
  | { ok: false; result: LlmResult }
  | { ok: true; text: string | undefined; toolCalls: ToolCall[]; rawItems: unknown[] };

/**
 * Builds the OpenAI-Responses request body from a neutral conversation. Shared
 * by the single-shot `callResponses` (no turns, `allowTools:false`) and the
 * agent turn variant: `tools` only when `allowTools`, `text.format` only when
 * `allowFormat` (never on tool turns). An assistant turn carrying `rawItems`
 * echoes them verbatim (OpenAI requires reasoning items returned with tool
 * calls to be passed back on the next turn); otherwise the text/function_call
 * items are constructed from the neutral turn.
 */
function buildResponsesBody(
  conv: Conversation,
  o: { model: string; temperature?: number; topP?: number; maxTokens: number },
  flags: ResponsesFlags,
): Record<string, unknown> {
  const input: unknown[] = [
    { role: "system", content: conv.system },
    { role: "user", content: conv.user },
  ];
  for (const turn of conv.turns ?? []) {
    if (turn.role === "assistant") {
      if (turn.rawItems !== undefined) {
        input.push(...turn.rawItems);
      } else {
        if (turn.text !== "") input.push({ role: "assistant", content: turn.text });
        for (const tc of turn.toolCalls) {
          input.push({ type: "function_call", call_id: tc.id, name: tc.name, arguments: tc.rawArgs });
        }
      }
    } else if (turn.role === "tool") {
      input.push({ type: "function_call_output", call_id: turn.id, output: turn.output });
    } else {
      input.push({ role: "user", content: turn.text });
    }
  }

  const body: Record<string, unknown> = {
    model: o.model,
    input,
    // The Responses API always budgets output via max_output_tokens,
    // including reasoning models (no max_completion_tokens here).
    max_output_tokens: o.maxTokens,
  };
  if (flags.allowTools && conv.tools !== undefined) {
    body.tools = conv.tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }
  if (flags.allowFormat) {
    body.text = {
      format: {
        type: "json_schema",
        name: PR_REVIEW_SCHEMA.name,
        schema: PR_REVIEW_SCHEMA.schema,
        strict: PR_REVIEW_SCHEMA.strict,
      },
    };
  }
  if (o.temperature !== undefined) body.temperature = o.temperature;
  if (o.topP !== undefined) body.top_p = o.topP;
  return body;
}

/**
 * Parses a Responses reply into the shared failure mappings plus the raw text,
 * tool calls and raw output items. Tool calls are parsed only when `allowTools`
 * (the single-shot path never expects them). `rawItems` is the raw `output`
 * array, echoed verbatim on the next turn so reasoning items survive. Refusal
 * reads as content-filter; `incomplete` degrades like truncation.
 */
function parseResponsesReply(json: unknown, flags: ResponsesFlags): ResponsesReply {
  // A refusal is reported as "content-filter" (the fixed set of failure reasons has no refusal entry).
  if (hasRefusal(json)) {
    return { ok: false, result: { ok: false, reason: "content-filter", detail: "model refused the request" } };
  }
  // The fixed set of failure reasons has no "incomplete" entry: truncation degrades as "invalid-json" (no diff-shrink retry).
  if ((json as { status?: unknown } | null)?.status === "incomplete") {
    return { ok: false, result: { ok: false, reason: "invalid-json", detail: "response truncated (status=incomplete)" } };
  }

  const output = (json as { output?: unknown } | null)?.output;
  const rawItems = Array.isArray(output) ? output : [];
  const toolCalls: ToolCall[] = [];
  if (flags.allowTools && Array.isArray(output)) {
    for (const raw of output) {
      const item = (raw ?? {}) as { type?: unknown; call_id?: unknown; name?: unknown; arguments?: unknown };
      if (item.type !== "function_call") continue;
      const rawArgs = typeof item.arguments === "string" ? item.arguments : "";
      let args: unknown;
      try {
        args = JSON.parse(rawArgs);
      } catch {
        // Malformed tool arguments must not throw: the call surfaces args: undefined.
        args = undefined;
      }
      toolCalls.push({
        id: typeof item.call_id === "string" ? item.call_id : "",
        name: typeof item.name === "string" ? item.name : "",
        args,
        rawArgs,
      });
    }
  }

  return { ok: true, text: joinOutputText(json), toolCalls, rawItems };
}

/**
 * OpenAI Responses API (`POST {base}/responses`): `{model, input, max_output_tokens,
 * text.format}` in, `output[].content[]` out. Same LlmResult union as the chat
 * caller: refusal reads as content-filter, `incomplete` degrades like `length`,
 * and a 400 on the strict format retries once without it (manual parse).
 */
export async function callResponses(
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
    // Hardcoded "openai": the callResponses signature carries no provider (per brief), and the
    // Responses wire format is provider-neutral here — sampling rules only need the OpenAI family.
    validateSampling({ model: o.model, temperature: o.temperature, topP: o.topP, provider: "openai" });
  } catch (e) {
    return { ok: false, reason: "unsupported", detail: redact(errMessage(e), key) };
  }

  const conv: Conversation = { system: messages.system, user: messages.user };
  const onFlags: ResponsesFlags = { allowTools: false, allowFormat: true };
  const offFlags: ResponsesFlags = { allowTools: false, allowFormat: false };
  let payload = JSON.stringify(buildResponsesBody(conv, o, onFlags));

  let a = await attempt(ep, payload, o);
  if (a.kind === "fail") return a.result;
  // Structured-output fallback: a 400 on the strict format retries once
  // without `text`, then the raw text is parsed manually.
  if (!a.ok && a.status === 400) {
    payload = JSON.stringify(buildResponsesBody(conv, o, offFlags));
    a = await attempt(ep, payload, o);
    if (a.kind === "fail") return a.result;
  }
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

  const reply = parseResponsesReply(json, onFlags);
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
  return { ok: true, findings };
}

/**
 * Agent-mode turn call on the OpenAI-Responses protocol. Same transport, retry
 * and failure mappings as `callResponses`, but translates a neutral
 * conversation (tools + prior turns) into `input`/`tools` and parses
 * `function_call` output items back. The `flags` gate the tool/format fields:
 * `text.format` is never sent on a tool turn. `rawItems` carries the raw
 * `output` array so reasoning items can be echoed verbatim on the next turn.
 */
export async function callResponsesTurn(
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
    validateSampling({ model: o.model, temperature: o.temperature, topP: o.topP, provider: "openai" });
  } catch (e) {
    return { ok: false, result: { ok: false, reason: "unsupported", detail: redact(errMessage(e), key) } };
  }

  const rFlags: ResponsesFlags = { allowTools: flags.allowTools, allowFormat: flags.allowFormat };
  let payload = JSON.stringify(buildResponsesBody(conv, o, rFlags));

  let a = await attempt(ep, payload, o);
  if (a.kind === "fail") return { ok: false, result: a.result };
  // Structured-output fallback: a 400 on the strict format retries once without it.
  if (!a.ok && a.status === 400 && rFlags.allowFormat) {
    payload = JSON.stringify(buildResponsesBody(conv, o, { ...rFlags, allowFormat: false }));
    a = await attempt(ep, payload, o);
    if (a.kind === "fail") return { ok: false, result: a.result };
  }
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
  const reply = parseResponsesReply(json, rFlags);
  if (!reply.ok) return { ok: false, result: reply.result };
  return {
    ok: true,
    text: reply.text ?? "",
    toolCalls: reply.toolCalls,
    ...(reply.rawItems.length > 0 ? { rawItems: reply.rawItems } : {}),
  };
}
