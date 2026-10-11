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

/** candidates[0] as an object, when present. */
function firstCandidate(json: unknown): Record<string, unknown> | undefined {
  const candidates = (json as { candidates?: unknown } | null)?.candidates;
  if (!Array.isArray(candidates)) return undefined;
  const c = candidates[0];
  return typeof c === "object" && c !== null ? (c as Record<string, unknown>) : undefined;
}

/** promptFeedback.blockReason when set (Gemini prompt-level blocks, often with empty candidates). */
function promptBlockReason(json: unknown): string | undefined {
  const feedback = (json as { promptFeedback?: unknown } | null)?.promptFeedback;
  if (typeof feedback !== "object" || feedback === null) return undefined;
  const r = (feedback as { blockReason?: unknown }).blockReason;
  return typeof r === "string" && r !== "" ? r : undefined;
}

/** Joins `text` blocks from `candidates[0].content.parts[]`. */
function joinCandidateText(json: unknown): string | undefined {
  const candidate = firstCandidate(json);
  const content = candidate?.content;
  if (typeof content !== "object" || content === null) return undefined;
  const parts = (content as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return undefined;
  const texts: string[] = [];
  for (const part of parts) {
    if (typeof part !== "object" || part === null) continue;
    const t = (part as { text?: unknown }).text;
    if (typeof t === "string") texts.push(t);
  }
  return texts.length > 0 ? texts.join("") : undefined;
}

/**
 * Converts the strict OpenAI-style schema subset used by PR_REVIEW_SCHEMA to
 * Google's OpenAPI-subset for `responseSchema`:
 * - `type: ["integer", "null"]` becomes `type: "integer", nullable: true`;
 * - `additionalProperties` is dropped (unsupported there), at every level;
 * - `required` is filtered to the properties the schema actually defines, so
 *   it stays valid;
 * - `properties` and `items` are converted recursively; everything else is
 *   copied as is. The caller keeps the retry-without-schema fallback as safety.
 */
export function googleSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "additionalProperties") continue;
    if (k === "type" && Array.isArray(v)) {
      // Single-type assumption: the schema subset used here has at most one
      // non-null type (e.g. ["integer", "null"]). A true multi-type union would
      // keep only its first member here; real unions need an anyOf expansion.
      const types = v.filter((t): t is string => typeof t === "string" && t !== "null");
      if (v.includes("null")) out.nullable = true;
      if (types.length > 0) out.type = types[0];
      continue;
    }
    if (k === "properties" && typeof v === "object" && v !== null && !Array.isArray(v)) {
      const props: Record<string, unknown> = {};
      for (const [name, sub] of Object.entries(v as Record<string, unknown>)) {
        props[name] =
          typeof sub === "object" && sub !== null && !Array.isArray(sub)
            ? googleSchema(sub as Record<string, unknown>)
            : sub;
      }
      out.properties = props;
      continue;
    }
    if (k === "items" && typeof v === "object" && v !== null && !Array.isArray(v)) {
      out.items = googleSchema(v as Record<string, unknown>);
      continue;
    }
    out[k] = v;
  }
  if (Array.isArray(out.required) && typeof out.properties === "object" && out.properties !== null) {
    const props = out.properties as Record<string, unknown>;
    const required = (out.required as unknown[]).filter((n) => typeof n === "string" && n in props);
    if (required.length > 0) out.required = required;
    else delete out.required;
  }
  return out;
}

/**
 * Shared google flags. `allowTools` gates `tools` (as `functionDeclarations`);
 * `allowFormat` gates `responseMimeType`+`responseSchema` (the single-shot
 * `callGoogle` sets it true, a tool turn may set it false).
 */
interface GoogleFlags {
  allowTools: boolean;
  allowFormat: boolean;
}

/** A parsed google reply: the failure union, or the extracted text + tool calls. */
type GoogleReply =
  | { ok: false; result: LlmResult }
  | { ok: true; text: string | undefined; toolCalls: ToolCall[]; rawItems: unknown[] };

/**
 * Builds the Google generateContent request body from a neutral conversation.
 * Shared by the single-shot `callGoogle` (no turns, `allowTools:false`) and the
 * agent turn variant: `tools` only when `allowTools` (as `functionDeclarations`
 * with `googleSchema` parameters); `responseMimeType`+`responseSchema` only when
 * `allowFormat`. `systemInstruction` rides in BOTH modes — the agent addendum
 * carries the untrusted-tool-output rule, so it must never be dropped. Assistant
 * turns become `role:"model"` parts (raw parts when available, otherwise text
 * then `functionCall`); consecutive tool-result turns collapse into ONE `role:"user"` part set (the API wants
 * every `functionResponse` for a parallel call set together). `modelId` is part
 * of the shared signature for parity with the call sites; the model id rides the
 * endpoint path (`:generateContent`), not the body, so it is not emitted here.
 */
function buildGoogleBody(
  conv: Conversation,
  modelId: string,
  o: { temperature?: number; topP?: number; maxTokens: number },
  flags: GoogleFlags,
): Record<string, unknown> {
  const contents: Array<Record<string, unknown>> = [
    { role: "user", parts: [{ text: conv.user }] },
  ];
  let pendingResults: Array<Record<string, unknown>> = [];
  const nativeCallIds = new Set<string>();
  const flushResults = (): void => {
    if (pendingResults.length > 0) {
      contents.push({ role: "user", parts: pendingResults });
      pendingResults = [];
    }
  };
  for (const turn of conv.turns ?? []) {
    if (turn.role === "assistant") {
      flushResults();
      nativeCallIds.clear();
      if (turn.rawItems !== undefined) {
        for (const item of turn.rawItems) {
          if (typeof item !== "object" || item === null) continue;
          const functionCall = (item as { functionCall?: unknown }).functionCall;
          if (typeof functionCall !== "object" || functionCall === null) continue;
          const id = (functionCall as { id?: unknown }).id;
          if (typeof id === "string" && id !== "") nativeCallIds.add(id);
        }
        contents.push({ role: "model", parts: turn.rawItems });
        continue;
      }
      const parts: Array<Record<string, unknown>> = [];
      if (turn.text) parts.push({ text: turn.text });
      for (const tc of turn.toolCalls) {
        parts.push({ functionCall: { name: tc.name, args: tc.args } });
      }
      contents.push({ role: "model", parts });
    } else if (turn.role === "tool") {
      const functionResponse: Record<string, unknown> = {
        name: turn.name,
        response: turn.isError ? { error: turn.output } : { output: turn.output },
      };
      if (nativeCallIds.has(turn.id)) functionResponse.id = turn.id;
      pendingResults.push({
        functionResponse,
      });
    } else {
      flushResults();
      contents.push({ role: "user", parts: [{ text: turn.text }] });
    }
  }
  flushResults();

  const generationConfig: Record<string, unknown> = { maxOutputTokens: o.maxTokens };
  if (flags.allowFormat) {
    generationConfig.responseMimeType = "application/json";
    generationConfig.responseSchema = googleSchema(PR_REVIEW_SCHEMA.schema);
  }
  if (o.temperature !== undefined) generationConfig.temperature = o.temperature;
  if (o.topP !== undefined) generationConfig.topP = o.topP;

  const body: Record<string, unknown> = {
    contents,
    systemInstruction: { parts: [{ text: conv.system }] },
    generationConfig,
  };
  if (flags.allowTools && conv.tools !== undefined) {
    body.tools = conv.tools.map((t) => ({
      functionDeclarations: [{ name: t.name, description: t.description, parameters: googleSchema(t.parameters) }],
    }));
  }
  return body;
}

/**
 * Parses a Google generateContent reply into the shared failure mappings plus the
 * raw text and tool calls. Prompt-level blocks (`promptFeedback.blockReason`) and
 * `finishReason` SAFETY/any other non-STOP value map to a content-filter skip
 * without retry; MAX_TOKENS degrades as "invalid-json". Tool calls
 * (`content.parts[].functionCall`) are parsed only when `allowTools`; provider
 * ids are preserved and calls without them receive a synthesized `fc_<index>` id.
 */
function parseGoogleReply(json: unknown, flags: GoogleFlags): GoogleReply {
  // A prompt-level block (e.g. SAFETY) is a provider-side skip, never retried —
  // it arrives as promptFeedback.blockReason, usually with no candidates at all.
  const blockReason = promptBlockReason(json);
  if (blockReason !== undefined) {
    return {
      ok: false,
      result: {
        ok: false,
        reason: "content-filter",
        detail: `provider blocked the prompt (blockReason=${blockReason})`,
      },
    };
  }

  const finishReason = firstCandidate(json)?.finishReason;
  // The fixed set of failure reasons has no "length" entry: truncation degrades
  // as "invalid-json" (no diff-shrink retry).
  if (finishReason === "MAX_TOKENS") {
    return { ok: false, result: { ok: false, reason: "invalid-json", detail: "response truncated (finishReason=MAX_TOKENS)" } };
  }
  // SAFETY and every other non-STOP finish reason is a provider-side skip, never retried
  // (reported as content-filter: the fixed set of failure reasons has no refusal entry).
  if (finishReason !== undefined && finishReason !== "STOP") {
    return {
      ok: false,
      result: {
        ok: false,
        reason: "content-filter",
        detail: `provider stopped the response (finishReason=${String(finishReason)})`,
      },
    };
  }

  const toolCalls: ToolCall[] = [];
  const content = firstCandidate(json)?.content;
  if (flags.allowTools && typeof content === "object" && content !== null) {
    const parts = (content as { parts?: unknown }).parts;
    if (Array.isArray(parts)) {
      const reservedIds = new Set<string>();
      for (const part of parts) {
        if (typeof part !== "object" || part === null) continue;
        const fc = (part as { functionCall?: unknown }).functionCall;
        if (typeof fc !== "object" || fc === null) continue;
        const id = (fc as { id?: unknown }).id;
        if (typeof id === "string" && id !== "") reservedIds.add(id);
      }

      let syntheticIndex = 0;
      for (const part of parts) {
        if (typeof part !== "object" || part === null) continue;
        const fc = (part as { functionCall?: unknown }).functionCall;
        if (typeof fc !== "object" || fc === null) continue;
        const call = fc as { id?: unknown; name?: unknown; args?: unknown };
        const args = call.args;
        let id: string;
        if (typeof call.id === "string" && call.id !== "") {
          id = call.id;
        } else {
          do {
            id = `fc_${syntheticIndex++}`;
          } while (reservedIds.has(id));
          reservedIds.add(id);
        }
        toolCalls.push({
          id,
          name: typeof call.name === "string" ? call.name : "",
          args,
          // Gemini's FunctionCall.args is optional; rawArgs is typed string, so
          // an argless call serializes to "{}" rather than undefined.
          rawArgs: JSON.stringify(args ?? {}),
        });
      }
    }
  }

  const contentParts = (firstCandidate(json)?.content as { parts?: unknown } | undefined)?.parts;
  return {
    ok: true,
    text: joinCandidateText(json),
    toolCalls,
    rawItems: Array.isArray(contentParts) ? contentParts : [],
  };
}

/**
 * Google generateContent (`POST {base}/models/<id>:generateContent`): the body is
 * `{contents, systemInstruction, generationConfig}` with `maxOutputTokens` for the
 * token budget. Structured output rides as `responseMimeType`+`responseSchema`; a 400
 * on it retries once without both (manual parse, like callResponses). Prompt-level
 * blocks (`promptFeedback.blockReason`) and `finishReason` SAFETY/any other non-STOP
 * value map to a content-filter skip without retry; MAX_TOKENS degrades. Auth prefers
 * the `x-goog-api-key` header: the key never rides the URL (`?key=` is never appended
 * by default) and is never logged.
 */
export async function callGoogle(
  ep: ResolvedEndpoint,
  modelId: string,
  messages: { system: string; user: string },
  o: {
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
    // Hardcoded "google": like callResponses/callMessages the signature carries no
    // provider, and validateSampling only needs the family check for strict rules.
    validateSampling({ model: modelId, temperature: o.temperature, topP: o.topP, provider: "google" });
  } catch (e) {
    return { ok: false, reason: "unsupported", detail: redact(errMessage(e), key) };
  }

  const conv: Conversation = { system: messages.system, user: messages.user };
  const onFlags: GoogleFlags = { allowTools: false, allowFormat: true };
  const offFlags: GoogleFlags = { allowTools: false, allowFormat: false };
  let payload = JSON.stringify(buildGoogleBody(conv, modelId, o, onFlags));

  // Spec §9.3 auth: prefer the x-goog-api-key header; the endpoint only lends its
  // User-Agent/session headers (Authorization is not part of this protocol, and
  // the query-string `?key=` fallback is never used by default — never logged).
  const headers: Record<string, string> = {
    ...ep.headers,
    "x-goog-api-key": key,
  };
  // Case-insensitive strip: Authorization is not part of this protocol, whatever its casing.
  for (const k of Object.keys(headers)) {
    if (/^authorization$/i.test(k)) delete headers[k];
  }
  const authEp: ResolvedEndpoint = { baseUrl: ep.baseUrl, path: ep.path, headers, apiStyle: ep.apiStyle };

  let a = await attempt(authEp, payload, o);
  if (a.kind === "fail") return a.result;
  // Structured-output fallback: a 400 on responseSchema retries once without it
  // (and without responseMimeType), then the raw text is parsed manually.
  if (!a.ok && a.status === 400) {
    payload = JSON.stringify(buildGoogleBody(conv, modelId, o, offFlags));
    a = await attempt(authEp, payload, o);
    if (a.kind === "fail") return a.result;
  }
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

  const reply = parseGoogleReply(json, onFlags);
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
 * Agent-mode turn call on the Google generateContent protocol. Same transport,
 * retry and failure mappings as `callGoogle`, but translates a neutral
 * conversation (tools + prior turns) into `contents`/`tools` and parses
 * `functionCall` parts back with synthesized `fc_<index>` ids. The `flags` gate
 * the tool/format fields: `responseSchema` is only sent when `allowFormat`. The
 * 400 schema-strip retry only applies when a schema was actually sent.
 */
export async function callGoogleTurn(
  ep: ResolvedEndpoint,
  modelId: string,
  conv: Conversation,
  o: {
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
    validateSampling({ model: modelId, temperature: o.temperature, topP: o.topP, provider: "google" });
  } catch (e) {
    return { ok: false, result: { ok: false, reason: "unsupported", detail: redact(errMessage(e), key) } };
  }

  const gFlags: GoogleFlags = { allowTools: flags.allowTools, allowFormat: flags.allowFormat };
  let payload = JSON.stringify(buildGoogleBody(conv, modelId, o, gFlags));

  // Spec §9.3 auth: prefer the x-goog-api-key header; the endpoint only lends its
  // User-Agent/session headers (Authorization is not part of this protocol, and
  // the query-string `?key=` fallback is never used by default — never logged).
  const headers: Record<string, string> = {
    ...ep.headers,
    "x-goog-api-key": key,
  };
  // Case-insensitive strip: Authorization is not part of this protocol, whatever its casing.
  for (const k of Object.keys(headers)) {
    if (/^authorization$/i.test(k)) delete headers[k];
  }
  const authEp: ResolvedEndpoint = { baseUrl: ep.baseUrl, path: ep.path, headers, apiStyle: ep.apiStyle };

  let a = await attempt(authEp, payload, o);
  if (a.kind === "fail") return { ok: false, result: a.result };
  // Structured-output fallback: a 400 on responseSchema retries once without it
  // (and without responseMimeType), then the raw text is parsed manually.
  if (!a.ok && a.status === 400 && gFlags.allowFormat) {
    payload = JSON.stringify(buildGoogleBody(conv, modelId, o, { ...gFlags, allowFormat: false }));
    a = await attempt(authEp, payload, o);
    if (a.kind === "fail") return { ok: false, result: a.result };
  }
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
  const reply = parseGoogleReply(json, gFlags);
  if (!reply.ok) return { ok: false, result: reply.result };
  return { ok: true, text: reply.text ?? "", toolCalls: reply.toolCalls, rawItems: reply.rawItems };
}
