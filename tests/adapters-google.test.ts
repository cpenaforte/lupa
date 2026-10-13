import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { callGoogle, callGoogleTurn, googleSchema } from "../src/adapters/google.js";
import { PR_REVIEW_SCHEMA } from "../src/prompt.js";
import type { ResolvedEndpoint } from "../src/providers.js";
import type { Conversation } from "../src/agent-types.js";

// ---------- helpers ----------

type Call = { url: string; init: RequestInit };
let calls: Call[] = [];

function stubFetch(h: (c: Call, n: number) => Promise<Response> | Response): void {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init: RequestInit = {}) => {
      const c = { url: String(url), init };
      calls.push(c);
      return h(c, calls.length);
    }),
  );
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

/** Minimal generateContent envelope carrying one text part (`extra` lands on candidates[0]). */
const okGoogle = (text: string, extra: Record<string, unknown> = {}) => ({
  candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP", ...extra }],
});

function lastBody(): Record<string, unknown> {
  return JSON.parse(String(calls.at(-1)!.init.body)) as Record<string, unknown>;
}

/** PR_REVIEW_SCHEMA.schema as Google's OpenAPI subset expects it (no additionalProperties, nullable flags). */
const EXPECTED_GOOGLE_SCHEMA = {
  type: "object",
  required: ["findings", "duplicates"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["severity", "file", "line", "rule", "message", "suggestion", "duplicateOf", "confidence", "patch"],
        properties: {
          severity: { type: "string", enum: ["info", "warning", "high"] },
          file: { type: "string" },
          line: { type: "integer", nullable: true },
          rule: { type: "string" },
          message: { type: "string" },
          suggestion: { type: "string", nullable: true },
          duplicateOf: { type: "integer", nullable: true },
          confidence: { type: "integer", nullable: true },
          patch: { type: "string", nullable: true },
        },
      },
    },
    duplicates: {
      type: "array",
      nullable: true,
      items: {
        type: "array",
        items: { type: "integer" },
        minItems: 2,
        maxItems: 2,
      },
    },
  },
};

/** Empty verdicts: the mocked replies below carry no verdict keys. */
const EMPTY_VERDICTS = { pairs: [], links: [], malformed: 0 };

/** Endpoint mirroring resolveEndpoint for the native Google path. */
function fakeGoogleEp(key = "k"): ResolvedEndpoint {
  return {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    path: "/models/gemini-2.5-flash:generateContent",
    headers: { "User-Agent": "pr-reviewer/1.0", "x-opencode-session": "pr-123" },
    apiStyle: "google-models",
  };
}

function msgs(): { system: string; user: string } {
  return { system: "s", user: '{"findings":[]}' };
}

function opts() {
  return { apiKey: "k", maxTokens: 50, timeoutSeconds: 5 };
}

const MODEL = "gemini-2.5-flash";

beforeEach(() => {
  calls = [];
  stubFetch(() => json(200, okGoogle('{"findings":[]}')));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------- tests ----------

describe("callGoogle", () => {
  it("posts exact {contents, systemInstruction, generationConfig} body to /models/<id>:generateContent", async () => {
    const r = await callGoogle(fakeGoogleEp(), MODEL, msgs(), opts());
    expect(r).toEqual({ ok: true, findings: [], verdicts: EMPTY_VERDICTS });
    // The endpoint path embeds the model id; the adapter posts to it as-is.
    expect(calls.at(-1)!.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    );
    expect(lastBody()).toEqual({
      contents: [{ role: "user", parts: [{ text: '{"findings":[]}' }] }],
      systemInstruction: { parts: [{ text: "s" }] },
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: EXPECTED_GOOGLE_SCHEMA,
        maxOutputTokens: 50,
      },
    });
  });

  // Spec §9.3: /models/<id>:generateContent is the real Google-protocol call —
  // the Zen/Go catalog /models/<id> entry is the AI SDK package descriptor,
  // not an inference endpoint. The adapter posts to whatever path resolveEndpoint supplies.
  it("uses the endpoint path as-is on a Zen base (spec §9.3: :generateContent is the real call)", async () => {
    const zenEp: ResolvedEndpoint = {
      baseUrl: "https://opencode.ai/zen/v1",
      path: "/models/gemini-2.5-flash:generateContent",
      headers: { Authorization: "Bearer k", "User-Agent": "pr-reviewer/1.0" },
      apiStyle: "google-models",
    };
    expect(await callGoogle(zenEp, MODEL, msgs(), opts())).toEqual({ ok: true, findings: [], verdicts: EMPTY_VERDICTS });
    expect(calls.at(-1)!.url).toBe("https://opencode.ai/zen/v1/models/gemini-2.5-flash:generateContent");
    expect(lastBody().contents).toEqual([{ role: "user", parts: [{ text: '{"findings":[]}' }] }]);
  });

  it("authenticates via x-goog-api-key header, never ?key= on the URL", async () => {
    const key = "SECRETKEY123";
    // Carries both Authorization casings: neither is part of this protocol.
    const ep: ResolvedEndpoint = {
      ...fakeGoogleEp(key),
      headers: {
        ...fakeGoogleEp(key).headers,
        Authorization: "Bearer stale",
        authorization: "Bearer stale",
      },
    };
    await callGoogle(ep, MODEL, msgs(), { ...opts(), apiKey: key });
    const headers = calls.at(-1)!.init.headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe(key);
    expect(headers["User-Agent"]).toBe("pr-reviewer/1.0");
    expect(headers["x-opencode-session"]).toBe("pr-123");
    expect(headers.Authorization).toBeUndefined();
    expect(headers["authorization"]).toBeUndefined();
    // The key never rides the URL, so it can never be logged from a request line.
    expect(calls.at(-1)!.url).not.toContain(key);
    expect(calls.at(-1)!.url).not.toContain("?key=");
  });

  it("omits generationConfig sampling by default; explicit temperature/topP ride along", async () => {
    await callGoogle(fakeGoogleEp(), MODEL, msgs(), opts());
    const gc = lastBody().generationConfig as Record<string, unknown>;
    expect(gc).not.toHaveProperty("temperature");
    expect(gc).not.toHaveProperty("top_p");
    expect(gc).not.toHaveProperty("topP");

    await callGoogle(fakeGoogleEp(), MODEL, msgs(), { ...opts(), temperature: 0.2, topP: 0.9 });
    const gc2 = lastBody().generationConfig as Record<string, unknown>;
    expect(gc2.temperature).toBe(0.2);
    expect(gc2.topP).toBe(0.9);
  });

  it("falls back without responseSchema/responseMimeType on 400 and parses manually", async () => {
    stubFetch((_c, n) =>
      n === 1 ? json(400, { error: "responseSchema not supported" }) : json(200, okGoogle('{"findings":[]}')),
    );
    const r = await callGoogle(fakeGoogleEp(), MODEL, msgs(), opts());
    expect(r).toEqual({ ok: true, findings: [], verdicts: EMPTY_VERDICTS });
    expect(calls.length).toBe(2);
    const first = JSON.parse(String(calls[0]!.init.body)) as { generationConfig?: Record<string, unknown> };
    expect(first.generationConfig?.responseSchema).toBeDefined();
    const second = JSON.parse(String(calls[1]!.init.body)) as { generationConfig?: Record<string, unknown> };
    expect(second.generationConfig).toBeDefined();
    expect(second.generationConfig).not.toHaveProperty("responseSchema");
    expect(second.generationConfig).not.toHaveProperty("responseMimeType");
    expect(second.generationConfig?.maxOutputTokens).toBe(50);
  });

  it("joins candidates[0].content.parts[].text and parses findings", async () => {
    stubFetch(() =>
      json(200, {
        candidates: [
          {
            content: { parts: [{ text: '{"findings":[' }, { text: "]}" }] },
            finishReason: "STOP",
          },
        ],
      }),
    );
    expect(await callGoogle(fakeGoogleEp(), MODEL, msgs(), opts())).toEqual({ ok: true, findings: [], verdicts: EMPTY_VERDICTS });
  });

  it("finishReason STOP→ok; MAX_TOKENS→degrade; SAFETY/other→skip without retry", async () => {
    stubFetch(() => json(200, okGoogle('{"findings":[]}', { finishReason: "MAX_TOKENS" })));
    expect(await callGoogle(fakeGoogleEp(), MODEL, msgs(), opts())).toMatchObject({
      ok: false,
      reason: "invalid-json",
    });

    stubFetch(() => json(200, okGoogle('{"findings":[]}', { finishReason: "SAFETY" })));
    expect(await callGoogle(fakeGoogleEp(), MODEL, msgs(), opts())).toMatchObject({
      ok: false,
      reason: "content-filter",
    });
    expect(calls.length).toBe(1);

    // Other non-STOP finish reasons (e.g. RECITATION) also skip, never retried.
    stubFetch(() => json(200, okGoogle('{"findings":[]}', { finishReason: "RECITATION" })));
    expect(await callGoogle(fakeGoogleEp(), MODEL, msgs(), opts())).toMatchObject({
      ok: false,
      reason: "content-filter",
    });
    expect(calls.length).toBe(1);

    stubFetch(() => json(200, okGoogle('{"findings":[]}')));
    expect(await callGoogle(fakeGoogleEp(), MODEL, msgs(), opts())).toEqual({ ok: true, findings: [], verdicts: EMPTY_VERDICTS });
  });

  it("promptFeedback.blockReason with empty candidates → content-filter skip, no retry", async () => {
    stubFetch(() => json(200, { promptFeedback: { blockReason: "SAFETY" }, candidates: [] }));
    expect(await callGoogle(fakeGoogleEp(), MODEL, msgs(), opts())).toEqual({
      ok: false,
      reason: "content-filter",
      detail: "provider blocked the prompt (blockReason=SAFETY)",
    });
    expect(calls.length).toBe(1);
  });

  it("retries once on 429/5xx and degrades on timeout without retry", async () => {
    // 429 → one retry (Retry-After: 0 keeps the backoff instant).
    stubFetch((_c, n) =>
      n === 1 ? json(429, { error: "rate limited" }, { "retry-after": "0" }) : json(200, okGoogle('{"findings":[]}')),
    );
    expect(await callGoogle(fakeGoogleEp(), MODEL, msgs(), opts())).toEqual({ ok: true, findings: [], verdicts: EMPTY_VERDICTS });
    expect(calls.length).toBe(2);

    // Persistent 5xx → exactly one retry (two calls, never three).
    stubFetch(() => json(503, { error: "unavailable" }, { "retry-after": "0" }));
    expect(await callGoogle(fakeGoogleEp(), MODEL, msgs(), opts())).toMatchObject({
      ok: false,
      reason: "http-error",
      status: 503,
    });
    expect(calls.length).toBe(2);

    // Timeout → degrade without any retry.
    const timeoutFetch = vi.fn(
      (url: string | URL, init: RequestInit) =>
        new Promise<Response>((_res, rej) => {
          calls.push({ url: String(url), init });
          init.signal?.addEventListener("abort", () => rej(new Error("aborted")));
        }),
    );
    vi.stubGlobal("fetch", timeoutFetch);
    calls = [];
    expect(await callGoogle(fakeGoogleEp(), MODEL, msgs(), { ...opts(), timeoutSeconds: 0.05 })).toMatchObject({
      ok: false,
      reason: "timeout",
    });
    expect(timeoutFetch).toHaveBeenCalledTimes(1);
    expect(calls.length).toBe(1);
  });

  it("persistent 5xx http-error detail redacts the API key", async () => {
    const key = "sk-secret-123";
    stubFetch(() => json(500, { error: `boom ${key}` }, { "retry-after": "0" }));
    const r = await callGoogle(fakeGoogleEp(key), MODEL, msgs(), { ...opts(), apiKey: key });
    expect(r).toMatchObject({ ok: false, reason: "http-error" });
    expect((r as { detail: string }).detail).toContain("[REDACTED]");
    expect((r as { detail: string }).detail).not.toContain(key);
    // 5xx → exactly one retry, then the plain http-error path (no schema fallback for 5xx).
    expect(calls.length).toBe(2);
  });
});

// ---------- callGoogleTurn ----------

describe("callGoogleTurn", () => {
  const toolDef = {
    name: "read_file",
    description: "Read a file",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  };

  const conv = (): Conversation => ({ system: "s", user: "u", tools: [toolDef] });
  const turnFlags = { allowTools: true, allowFormat: false };

  it("turn mode sends functionDeclarations with googleSchema parameters and no responseSchema", async () => {
    const c = conv();
    await callGoogleTurn(fakeGoogleEp(), MODEL, c, opts(), turnFlags);
    const body = lastBody();
    expect(body.tools).toEqual([
      {
        functionDeclarations: [
          { name: "read_file", description: "Read a file", parameters: googleSchema(toolDef.parameters) },
        ],
      },
    ]);
    expect(body.generationConfig as Record<string, unknown>).not.toHaveProperty("responseSchema");
    expect(body.generationConfig as Record<string, unknown>).not.toHaveProperty("responseMimeType");
    // The system instruction (with the agent addendum) must ride in BOTH modes.
    expect(body.systemInstruction).toEqual({ parts: [{ text: "s" }] });
    expect((body.systemInstruction as { parts: Array<{ text: string }> }).parts[0]!.text).toBe(c.system);
  });

  it("echoes model functionCall parts and role=user functionResponse parts", async () => {
    const c: Conversation = {
      system: "s",
      user: "u",
      turns: [
        {
          role: "assistant",
          text: "thinking",
          toolCalls: [
            { id: "fc_0", name: "read_file", args: { path: "a.ts" }, rawArgs: '{"path":"a.ts"}' },
            { id: "fc_1", name: "read_file", args: { path: "b.ts" }, rawArgs: '{"path":"b.ts"}' },
          ],
        },
        { role: "tool", id: "fc_0", name: "read_file", output: "ok" },
        { role: "tool", id: "fc_1", name: "read_file", output: "boom", isError: true },
      ],
      tools: [toolDef],
    };
    await callGoogleTurn(fakeGoogleEp(), MODEL, c, opts(), turnFlags);
    expect(lastBody().contents).toEqual([
      { role: "user", parts: [{ text: "u" }] },
      {
        role: "model",
        parts: [
          { text: "thinking" },
          { functionCall: { name: "read_file", args: { path: "a.ts" } } },
          { functionCall: { name: "read_file", args: { path: "b.ts" } } },
        ],
      },
      {
        role: "user",
        parts: [
          { functionResponse: { name: "read_file", response: { output: "ok" } } },
          { functionResponse: { name: "read_file", response: { error: "boom" } } },
        ],
      },
    ]);
  });

  it("replays assistant rawItems (thoughtSignature + native ids) verbatim", async () => {
    const c: Conversation = {
      system: "s", user: "u",
      turns: [{
        role: "assistant", text: "t",
        toolCalls: [{ id: "fc_0", name: "read_file", args: { path: "a.ts" }, rawArgs: '{"path":"a.ts"}' }],
        rawItems: [{ text: "t", thoughtSignature: "sig-123" }, { functionCall: { id: "native-1", name: "read_file", args: { path: "a.ts" } } }],
      }],
      tools: [toolDef],
    };
    await callGoogleTurn(fakeGoogleEp(), MODEL, c, opts(), turnFlags);
    expect(lastBody().contents).toEqual([
      { role: "user", parts: [{ text: "u" }] },
      { role: "model", parts: [{ text: "t", thoughtSignature: "sig-123" }, { functionCall: { id: "native-1", name: "read_file", args: { path: "a.ts" } } }] },
    ]);
  });

  it("matches a native function call ID on the next functionResponse", async () => {
    stubFetch((_c, n) => n === 1
      ? json(200, {
          candidates: [{
            content: { parts: [
              { text: "checking", thoughtSignature: "sig-native" },
              { functionCall: { id: "native-call-7", name: "read_file", args: { path: "a.ts" } } },
            ] },
            finishReason: "STOP",
          }],
        })
      : json(200, okGoogle("done")));

    const first = await callGoogleTurn(fakeGoogleEp(), MODEL, conv(), opts(), turnFlags);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const call = first.toolCalls[0]!;
    await callGoogleTurn(fakeGoogleEp(), MODEL, {
      system: "s",
      user: "u",
      tools: [toolDef],
      turns: [
        { role: "assistant", text: first.text, toolCalls: first.toolCalls, rawItems: first.rawItems },
        { role: "tool", id: call.id, name: call.name, output: "file contents" },
      ],
    }, opts(), turnFlags);

    expect(lastBody().contents).toEqual([
      { role: "user", parts: [{ text: "u" }] },
      { role: "model", parts: [
        { text: "checking", thoughtSignature: "sig-native" },
        { functionCall: { id: "native-call-7", name: "read_file", args: { path: "a.ts" } } },
      ] },
      { role: "user", parts: [
        { functionResponse: { id: "native-call-7", name: "read_file", response: { output: "file contents" } } },
      ] },
    ]);
  });

  it("reserves native IDs when synthesizing IDs for mixed function calls", async () => {
    stubFetch((_c, n) => n === 1
      ? json(200, {
          candidates: [{
            content: { parts: [
              { functionCall: { id: "fc_1", name: "read_file", args: { path: "native.ts" } } },
              { functionCall: { name: "read_file", args: { path: "synthetic.ts" } } },
            ] },
            finishReason: "STOP",
          }],
        })
      : json(200, okGoogle("done")));

    const first = await callGoogleTurn(fakeGoogleEp(), MODEL, conv(), opts(), turnFlags);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.toolCalls.map((call) => call.id)).toEqual(["fc_1", "fc_0"]);
    expect(new Set(first.toolCalls.map((call) => call.id)).size).toBe(2);

    await callGoogleTurn(fakeGoogleEp(), MODEL, {
      system: "s",
      user: "u",
      tools: [toolDef],
      turns: [
        { role: "assistant", text: first.text, toolCalls: first.toolCalls, rawItems: first.rawItems },
        { role: "tool", id: first.toolCalls[0]!.id, name: "read_file", output: "native result" },
        { role: "tool", id: first.toolCalls[1]!.id, name: "read_file", output: "synthetic result" },
      ],
    }, opts(), turnFlags);

    const contents = lastBody().contents as Array<{ role: string; parts: unknown[] }>;
    expect(contents[2]!.parts).toEqual([
      { functionResponse: { id: "fc_1", name: "read_file", response: { output: "native result" } } },
      { functionResponse: { name: "read_file", response: { output: "synthetic result" } } },
    ]);
  });

  it("parses functionCall parts with synthesized fc_ ids", async () => {
    stubFetch(() =>
      json(200, {
        candidates: [
          {
            content: {
              parts: [
                { functionCall: { name: "read_file", args: { path: "a.ts" } } },
                { functionCall: { name: "read_file", args: { path: "b.ts" } } },
              ],
            },
            finishReason: "STOP",
          },
        ],
      }),
    );
    const r = await callGoogleTurn(fakeGoogleEp(), MODEL, conv(), opts(), turnFlags);
    expect(r).toEqual({
      ok: true,
      text: "",
      toolCalls: [
        { id: "fc_0", name: "read_file", args: { path: "a.ts" }, rawArgs: '{"path":"a.ts"}' },
        { id: "fc_1", name: "read_file", args: { path: "b.ts" }, rawArgs: '{"path":"b.ts"}' },
      ],
      rawItems: [
        { functionCall: { name: "read_file", args: { path: "a.ts" } } },
        { functionCall: { name: "read_file", args: { path: "b.ts" } } },
      ],
    });
  });

  it("honors the rawArgs string contract for an argless functionCall", async () => {
    // Gemini's FunctionCall.args is optional; rawArgs is typed string, so an
    // argless call must serialize to "{}" (never undefined).
    stubFetch(() =>
      json(200, {
        candidates: [
          { content: { parts: [{ functionCall: { name: "read_file" } }] }, finishReason: "STOP" },
        ],
      }),
    );
    const r = await callGoogleTurn(fakeGoogleEp(), MODEL, conv(), opts(), turnFlags);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.toolCalls).toHaveLength(1);
      expect(r.toolCalls[0]!.name).toBe("read_file");
      expect(r.toolCalls[0]!.rawArgs).toBe("{}");
      expect(r.toolCalls[0]!.args).toBeUndefined();
    }
  });

  it("text and functionCall parts together parse both", async () => {
    stubFetch(() =>
      json(200, {
        candidates: [
          {
            content: {
              parts: [
                { text: "thinking" },
                { functionCall: { name: "read_file", args: { path: "a.ts" } } },
              ],
            },
            finishReason: "STOP",
          },
        ],
      }),
    );
    const r = await callGoogleTurn(fakeGoogleEp(), MODEL, conv(), opts(), turnFlags);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toBe("thinking");
      expect(r.toolCalls).toHaveLength(1);
      expect(r.toolCalls[0]!.id).toBe("fc_0");
      expect(r.toolCalls[0]!.name).toBe("read_file");
      expect(r.toolCalls[0]!.args).toEqual({ path: "a.ts" });
    }
  });
});

// ---------- googleSchema ----------

describe("googleSchema", () => {
  it("converts type arrays to a single type plus nullable", () => {
    expect(googleSchema({ type: ["integer", "null"] })).toEqual({ type: "integer", nullable: true });
    expect(googleSchema({ type: ["string", "null"] })).toEqual({ type: "string", nullable: true });
  });

  it("drops additionalProperties at every level of PR_REVIEW_SCHEMA", () => {
    const out = googleSchema(PR_REVIEW_SCHEMA.schema);
    expect(JSON.stringify(out)).not.toContain("additionalProperties");
  });

  it("preserves nested items, arrays and required arrays", () => {
    const out = googleSchema(PR_REVIEW_SCHEMA.schema) as typeof EXPECTED_GOOGLE_SCHEMA;
    const items = out.properties.findings.items;
    expect(out.properties.findings.type).toBe("array");
    expect(out.required).toEqual(["findings", "duplicates"]);
    expect(items.required).toEqual(["severity", "file", "line", "rule", "message", "suggestion", "duplicateOf", "confidence", "patch"]);
    expect(items.properties.line).toEqual({ type: "integer", nullable: true });
    expect(items.properties.severity).toEqual({ type: "string", enum: ["info", "warning", "high"] });
    expect(items.properties.duplicateOf).toEqual({ type: "integer", nullable: true });
    expect(items.properties.confidence).toEqual({ type: "integer", nullable: true });
    expect(items.properties.patch).toEqual({ type: "string", nullable: true });
  });

  it("converts nullable duplicates with minItems/maxItems passed through", () => {
    const out = googleSchema(PR_REVIEW_SCHEMA.schema) as typeof EXPECTED_GOOGLE_SCHEMA;
    expect(out.properties.duplicates).toEqual({
      type: "array",
      nullable: true,
      items: { type: "array", items: { type: "integer" }, minItems: 2, maxItems: 2 },
    });
  });

  it("keeps a required array valid when it names a property the schema does not define", () => {
    const out = googleSchema({
      type: "object",
      required: ["a", "ghost"],
      properties: { a: { type: "string" } },
    });
    expect(out.required).toEqual(["a"]);
  });
});
