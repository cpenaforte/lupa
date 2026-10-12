import { describe, it, expect, vi, afterEach } from "vitest";
import { callByStyle } from "../src/llm.js";
import { resolveEndpoint, type ResolvedApiStyle } from "../src/providers.js";
import { googleSchema } from "../src/adapters/google.js";
import { PR_REVIEW_SCHEMA } from "../src/prompt.js";

// ---------- helpers ----------

const base = { llmBaseUrl: "", llmApiStyle: "auto", llmPath: "", llmApiKey: "k", prNumber: 1 } as const;

const FINDING = { severity: "warning", file: "src/a.ts", line: 2, rule: "logic", message: "m", suggestion: "sug" };
const FINDINGS_JSON = JSON.stringify({ findings: [FINDING] });

/** One protocol-shaped success envelope per style, all carrying the same findings JSON. */
const CHAT_OK = { choices: [{ finish_reason: "stop", message: { content: FINDINGS_JSON } }] };
const RESPONSES_OK = {
  status: "completed",
  output: [{ type: "message", content: [{ type: "output_text", text: FINDINGS_JSON }] }],
};
const MESSAGES_OK = { stop_reason: "end_turn", content: [{ type: "text", text: FINDINGS_JSON }] };
const GOOGLE_OK = { candidates: [{ content: { parts: [{ text: FINDINGS_JSON }] }, finishReason: "STOP" }] };

const msgs = { system: "s", user: "u" };
const opts = { apiKey: "k", maxTokens: 50, timeoutSeconds: 5, provider: "opencode-zen" };

function stubFetch(handler: () => Response): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => handler()),
  );
}

function lastCall(): [string, RequestInit] {
  const mock = vi.mocked(fetch).mock;
  const c = mock.calls.at(-1)!;
  return [String(c[0]), c[1] as RequestInit];
}

function lastBody(): Record<string, any> {
  return JSON.parse(String(lastCall()[1].body));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------- routing: auto defers to the probe; providers own base + headers ----------

describe("resolveEndpoint: base URLs and auth headers are per provider", () => {
  it("base URLs and auth headers are unchanged by routing", () => {
    const zen = resolveEndpoint({ ...base, llmProvider: "opencode-zen", llmModel: "gpt-6-luna" });
    expect(zen.baseUrl).toBe("https://opencode.ai/zen/v1");
    expect(zen.headers.Authorization).toBe("Bearer k");
    expect(zen.headers["x-opencode-session"]).toBeUndefined();
    const go = resolveEndpoint({ ...base, llmProvider: "opencode-go", llmModel: "qwen3.8-max" });
    expect(go.baseUrl).toBe("https://opencode.ai/zen/go/v1");
    expect(go.headers["x-opencode-session"]).toBe("pr-1");
  });
});

// ---------- explicit v2 styles are functional ----------

describe("resolveEndpoint: explicit v2 llm_api_style values are functional", () => {
  it("explicit openai-responses resolves the /responses path", () => {
    const r = resolveEndpoint({ ...base, llmProvider: "openai", llmModel: "m", llmApiStyle: "openai-responses" });
    expect(r.apiStyle).toBe("openai-responses");
    expect(r.baseUrl).toBe("https://api.openai.com/v1");
    expect(r.path).toBe("/responses");
  });

  it("explicit anthropic-messages resolves the /messages path on the anthropic preset", () => {
    const r = resolveEndpoint({ ...base, llmProvider: "anthropic", llmModel: "m", llmApiStyle: "anthropic-messages" });
    expect(r.apiStyle).toBe("anthropic-messages");
    expect(r.baseUrl).toBe("https://api.anthropic.com/v1");
    expect(r.path).toBe("/messages");
  });

  it("explicit google-models resolves the model path on the google preset", () => {
    const r = resolveEndpoint({ ...base, llmProvider: "google", llmModel: "gemini-x", llmApiStyle: "google-models" });
    expect(r.apiStyle).toBe("google-models");
    // The preset base ends in the OpenAI-compat segment; the native path drops it.
    expect(r.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta");
    expect(r.baseUrl + r.path).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent");
  });

  it("explicit v2 style on a custom base_url resolves", () => {
    const r = resolveEndpoint({
      ...base,
      llmProvider: "custom",
      llmBaseUrl: "https://x/v1",
      llmModel: "m",
      llmApiStyle: "anthropic-messages",
    });
    expect(r.apiStyle).toBe("anthropic-messages");
    expect(r.baseUrl + r.path).toBe("https://x/v1/messages");
  });

  it("v2 style with an explicit llm_path override keeps the override (no path-only guard)", () => {
    const r = resolveEndpoint({
      ...base,
      llmProvider: "custom",
      llmBaseUrl: "https://x",
      llmModel: "m",
      llmApiStyle: "anthropic-messages",
      llmPath: "/v1beta/messages",
    });
    expect(r.apiStyle).toBe("anthropic-messages");
    expect(r.path).toBe("/v1beta/messages");
  });
});

// ---------- fail-fast cases that stay ----------

describe("resolveEndpoint: fail-fast cases that stay", () => {
  it("unknown custom pair with a non-chat llm_path and no v2 style stays path-only", () => {
    expect(() =>
      resolveEndpoint({
        ...base,
        llmProvider: "custom",
        llmBaseUrl: "https://x",
        llmModel: "m",
        llmPath: "/v1/messages",
      }),
    ).toThrow(/path-only/);
  });

  it("explicit custom-path still requires llm_path", () => {
    expect(() =>
      resolveEndpoint({ ...base, llmProvider: "custom", llmBaseUrl: "https://x", llmModel: "m", llmApiStyle: "custom-path" }),
    ).toThrow(/requires llm_path/);
  });
});

// ---------- dispatcher: each apiStyle calls the right adapter ----------

describe("callByStyle dispatches to the adapter of the resolved style", () => {
  it("openai-chat → callLlm request shape, identical LlmResult", async () => {
    stubFetch(() => new Response(JSON.stringify(CHAT_OK), { status: 200 }));
    const ep = resolveEndpoint({ ...base, llmProvider: "openai", llmModel: "m", llmApiStyle: "openai-chat" });
    const r = await callByStyle(ep, msgs, { ...opts, model: "m", provider: "openai" });
    expect(r).toEqual({ ok: true, findings: [FINDING], verdicts: { pairs: [], links: [], malformed: 0 } });
    const [url, init] = lastCall();
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(init.method).toBe("POST");
    const body = lastBody();
    expect(body.model).toBe("m");
    expect(body.messages).toEqual([
      { role: "system", content: "s" },
      { role: "user", content: "u" },
    ]);
    expect(body.max_tokens).toBe(50);
    expect(body.response_format).toEqual({ type: "json_schema", json_schema: PR_REVIEW_SCHEMA });
  });

  it("openai-responses → callResponses request shape, identical LlmResult", async () => {
    stubFetch(() => new Response(JSON.stringify(RESPONSES_OK), { status: 200 }));
    const ep = resolveEndpoint({ ...base, llmProvider: "opencode-zen", llmModel: "gpt-6-luna", llmApiStyle: "openai-responses" });
    const r = await callByStyle(ep, msgs, { ...opts, model: "gpt-6-luna" });
    expect(r).toEqual({ ok: true, findings: [FINDING], verdicts: { pairs: [], links: [], malformed: 0 } });
    const [url, init] = lastCall();
    expect(url).toBe("https://opencode.ai/zen/v1/responses");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k");
    const body = lastBody();
    expect(body.model).toBe("gpt-6-luna");
    expect(body.input).toEqual([
      { role: "system", content: "s" },
      { role: "user", content: "u" },
    ]);
    expect(body.max_output_tokens).toBe(50);
    expect(body.text.format.type).toBe("json_schema");
  });

  it("anthropic-messages → callMessages request shape, identical LlmResult", async () => {
    stubFetch(() => new Response(JSON.stringify(MESSAGES_OK), { status: 200 }));
    const ep = resolveEndpoint({ ...base, llmProvider: "opencode-zen", llmModel: "claude-sonnet-5-5", llmApiStyle: "anthropic-messages" });
    const r = await callByStyle(ep, msgs, { ...opts, model: "claude-sonnet-5-5" });
    expect(r).toEqual({ ok: true, findings: [FINDING], verdicts: { pairs: [], links: [], malformed: 0 } });
    const [url, init] = lastCall();
    expect(url).toBe("https://opencode.ai/zen/v1/messages");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("k");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers.Authorization).toBeUndefined();
    const body = lastBody();
    expect(body.model).toBe("claude-sonnet-5-5");
    expect(body.max_tokens).toBe(50);
    expect(body.system).toBe("s");
    expect(body.messages).toEqual([{ role: "user", content: "u" }]);
    expect(body).not.toHaveProperty("response_format");
  });

  it("google-models → callGoogle request shape (Google-native schema), identical LlmResult", async () => {
    stubFetch(() => new Response(JSON.stringify(GOOGLE_OK), { status: 200 }));
    const ep = resolveEndpoint({ ...base, llmProvider: "opencode-zen", llmModel: "gemini-3.8-flash", llmApiStyle: "google-models" });
    const r = await callByStyle(ep, msgs, { ...opts, model: "gemini-3.8-flash" });
    expect(r).toEqual({ ok: true, findings: [FINDING], verdicts: { pairs: [], links: [], malformed: 0 } });
    const [url, init] = lastCall();
    expect(url).toBe("https://opencode.ai/zen/v1/models/gemini-3.8-flash:generateContent");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe("k");
    expect(headers.Authorization).toBeUndefined();
    const body = lastBody();
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: "u" }] }]);
    expect(body.systemInstruction).toEqual({ parts: [{ text: "s" }] });
    const gc = body.generationConfig;
    expect(gc.maxOutputTokens).toBe(50);
    expect(gc.responseMimeType).toBe("application/json");
    // Google-native schema: no additionalProperties anywhere, nullable via type+nullable.
    expect(JSON.stringify(gc.responseSchema)).not.toContain("additionalProperties");
    expect(gc.responseSchema.properties.findings.items.properties.line).toEqual({
      type: "integer",
      nullable: true,
    });
  });

  it("protocol refusals/blocks all map to the same content-filter reason", async () => {
    const cases: Array<[Parameters<typeof resolveEndpoint>[0], unknown]> = [
      [{ ...base, llmProvider: "openai", llmModel: "m", llmApiStyle: "openai-chat" }, { choices: [{ finish_reason: "stop", message: { content: "", refusal: "no" } }] }],
      [{ ...base, llmProvider: "opencode-zen", llmModel: "gpt-6-luna", llmApiStyle: "openai-responses" }, { output: [{ content: [{ type: "refusal", refusal: "no" }] }] }],
      [{ ...base, llmProvider: "opencode-zen", llmModel: "claude-sonnet-5-5", llmApiStyle: "anthropic-messages" }, { stop_reason: "refusal", content: [] }],
      [{ ...base, llmProvider: "opencode-zen", llmModel: "gemini-3.8-flash", llmApiStyle: "google-models" }, { promptFeedback: { blockReason: "SAFETY" } }],
    ];
    for (const [o, envelope] of cases) {
      stubFetch(() => new Response(JSON.stringify(envelope), { status: 200 }));
      const ep = resolveEndpoint(o);
      const r = await callByStyle(ep, msgs, { ...opts, model: "m" });
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.reason).toBe("content-filter");
    }
  });

  // Micro fix 1: the "fail loudly" promise is backed by code — no silent chat fallback.
  it("a forged apiStyle throws instead of falling back to chat", async () => {
    const ep = {
      ...resolveEndpoint({ ...base, llmProvider: "openai", llmModel: "m" }),
      apiStyle: "bogus-style" as unknown as ResolvedApiStyle,
    };
    await expect(callByStyle(ep, msgs, { ...opts, model: "m" })).rejects.toThrow("unsupported apiStyle: bogus-style");
  });
});
