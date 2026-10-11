import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  callLlm,
  callChatTurn,
  validateSampling,
  tokenFieldFor,
  parseContent,
  ensureOllama,
  OllamaMissingError,
  InvalidJsonError,
} from "../src/llm.js";
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

const okChat = (content: string | null = '{"findings":[]}', extra: Record<string, unknown> = {}) => ({
  choices: [{ finish_reason: "stop", message: { content, ...extra } }],
});

function lastBody(): any {
  return JSON.parse(String(calls.at(-1)!.init.body));
}

function fetchCallCount(): number {
  return calls.length;
}

/** Endpoint per provider: base URL + chat path + bearer header with a dummy key. */
function fakeEp(p: string, key = "k"): ResolvedEndpoint {
  return {
    baseUrl: `https://${p}.test/v1`,
    path: "/chat/completions",
    headers: { Authorization: `Bearer ${key}`, "User-Agent": "pr-reviewer/1.0" },
    apiStyle: "openai-chat",
  };
}
const fakeOpenAiEp = () => fakeEp("openai");
const fakeAnthropicEp = () => fakeEp("anthropic");
const fakeOllamaEp = () => fakeEp("ollama");

function msgs(): { system: string; user: string } {
  return { system: "s", user: '{"findings":[]}' };
}

function opts(provider = "openai") {
  return {
    model: "m",
    apiKey: "k",
    maxTokens: 50,
    timeoutSeconds: 5,
    provider,
  };
}

beforeEach(() => {
  calls = [];
  stubFetch(() => json(200, okChat()));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Fetch mock returning a refusal alongside valid content; true iff callLlm treated it as failure. */
async function refusalHonored(p: string): Promise<boolean> {
  stubFetch(() => json(200, okChat('{"findings":[]}', { refusal: "x" })));
  const r = await callLlm(fakeEp(p), msgs(), opts(p));
  return !r.ok;
}

/** Fetch mock that never answers until aborted; resolves with the LlmResult. */
function callLlmWithTimeout(timeoutSeconds: number) {
  stubFetch(
    (c) =>
      new Promise<Response>((_, rej) => {
        c.init.signal?.addEventListener("abort", () =>
          rej(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      }),
  );
  return callLlm(fakeOpenAiEp(), msgs(), { ...opts(), timeoutSeconds });
}

/** Fetch mock answering 500 for every attempt; never throws. */
function callLlmFailing(key: string) {
  stubFetch(() => json(500, { error: `upstream rejected key ${key}` }));
  return callLlm(fakeEp("openai", key), msgs(), { ...opts(), apiKey: key });
}

/** Fetch mock throwing a network error that echoes the key. */
function callLlmThrowing(key: string) {
  stubFetch(() => {
    throw new Error(`getaddrinfo failed (auth ${key})`);
  });
  return callLlm(fakeEp("openai", key), msgs(), { ...opts(), apiKey: key });
}

// ---------- tests ----------

describe("validateSampling", () => {
  it("rejects bad sampling per family, allows generic ranges", () => {
    expect(() => validateSampling({ model: "o1", temperature: 0.5, provider: "openai" })).toThrow(/reasoning/);
    expect(() => validateSampling({ model: "o3-mini", provider: "openai", n: 2 })).toThrow(/reasoning/);
    expect(() => validateSampling({ model: "claude-sonnet-5-5", temperature: 0, provider: "anthropic" })).toThrow(/400|reasoning/);
    expect(() => validateSampling({ model: "x", provider: "anthropic", n: 2 })).toThrow(
      "Anthropic-compat supports only n=1; n must be 1 or unset",
    );
    expect(() => validateSampling({ model: "x", provider: "anthropic", n: 1 })).not.toThrow();
    expect(() => validateSampling({ model: "m", provider: "custom", apiStyle: "anthropic-messages", temperature: 0.5, topP: 0.9 })).toThrow(/both|together/);
    expect(() => validateSampling({ model: "generic-claude", provider: "anthropic", temperature: 0.5 })).not.toThrow();
    expect(() => validateSampling({ model: "generic-claude", provider: "anthropic", topP: 0.9 })).not.toThrow();
    expect(() => validateSampling({ model: "gpt-6-luna", provider: "openai", topP: 0.9 })).toThrow(/reasoning/);
    expect(() => validateSampling({ model: "gpt-6-luna", provider: "openai", n: 2 })).toThrow(/reasoning/);
    expect(() => validateSampling({ model: "m", provider: "openai", n: 2 })).not.toThrow();
    expect(() => validateSampling({ model: "x", provider: "anthropic" })).not.toThrow();
  });

  it("matches strict family case-insensitively (O1, claude-4.8, claude-4.10, haiku-5-5)", () => {
    expect(() => validateSampling({ model: "O1", provider: "openai", temperature: 0.5 })).toThrow(/reasoning/);
    expect(() => validateSampling({ model: "claude-4.8", provider: "custom", temperature: 0.5 })).toThrow(/reasoning/);
    expect(() => validateSampling({ model: "claude-4.10", provider: "custom", topP: 0.5 })).toThrow(/reasoning/);
    expect(() => validateSampling({ model: "claude-haiku-5-5", provider: "anthropic", topP: 0.5 })).toThrow(/400|reasoning/);
  });

  it.each([
    "claude-sonnet-5-5",
    "claude-opus-5-5",
    "claude-haiku-5-5",
    "claude-sonnet-4-7",
    "claude-opus-4-8",
    "claude-4.10",
    "claude-opus-4-10-20260101",
    "claude-6",
    "gpt-5.6-luna",
    "gpt-6-luna",
    "o1",
    "o3-mini",
  ])("strict family: %s rejects an explicit temperature on openai", (model) => {
    expect(() => validateSampling({ model, provider: "openai", temperature: 0 })).toThrow(/reasoning/);
  });

  it.each([
    "claude-haiku-4-5",
    "claude-haiku-4-5-20251001",
    "claude-sonnet-4-6",
    "claude-opus-4-6",
    "claude-opus-4-20250514",
    "claude-3-5-sonnet-20241022",
    "claude-3-7-sonnet-20250219",
    "claude-2.1",
  ])("not strict: %s accepts an explicit temperature on openai", (model) => {
    expect(() => validateSampling({ model, provider: "openai", temperature: 0 })).not.toThrow();
    expect(() => validateSampling({ model, provider: "openai", topP: 0.9, n: 2 })).not.toThrow();
    expect(tokenFieldFor(model)).toBe("max_tokens");
  });

  it("generic anthropic-compat range checks: out-of-range throws, in-range passes", () => {
    expect(() => validateSampling({ model: "x", provider: "anthropic", temperature: 1.5 })).toThrow();
    expect(() => validateSampling({ model: "x", provider: "anthropic", topP: -0.1 })).toThrow();
    expect(() => validateSampling({ model: "x", provider: "anthropic", temperature: 1, topP: undefined, n: 1 })).not.toThrow();
  });
});

describe("tokenFieldFor", () => {
  it("maps reasoning to max_completion_tokens, never claude", () => {
    expect(tokenFieldFor("gpt-6-luna")).toBe("max_completion_tokens");
    expect(tokenFieldFor("o1")).toBe("max_completion_tokens");
    expect(tokenFieldFor("o3-mini")).toBe("max_completion_tokens");
    expect(tokenFieldFor("claude-sonnet-5-5")).toBe("max_tokens");
    expect(tokenFieldFor("deepseek-v4.1-flash")).toBe("max_tokens");
  });
});

describe("callLlm request shape", () => {
  it("explicit sampling IS sent for openai non-reasoning, still omitted for anthropic", async () => {
    await callLlm(fakeOpenAiEp(), msgs(), { ...opts(), model: "gpt-4o-mini", temperature: 0.3 });
    expect(lastBody().temperature).toBe(0.3);
    await callLlm(fakeAnthropicEp(), msgs(), { ...opts("anthropic"), temperature: 0.3 });
    expect(lastBody().temperature).toBeUndefined();
  });

  it("omits temperature/top_p/n by default", async () => {
    await callLlm(fakeOpenAiEp(), msgs(), opts());
    expect(lastBody().temperature).toBeUndefined();
    expect(lastBody().top_p).toBeUndefined();
    expect(lastBody().n).toBeUndefined();
  });

  it("zen-chat gets strict full shape like openai", async () => {
    await callLlm(fakeEp("opencode-zen"), msgs(), { ...opts("opencode-zen"), model: "deepseek-v4.1-flash" });
    expect(lastBody().response_format).toMatchObject({
      type: "json_schema",
      json_schema: { name: "pr_review", strict: true },
    });
  });

  it("response_format per provider: strict openai, json_object groq/mistral, omitted anthropic", async () => {
    await callLlm(fakeEp("groq"), msgs(), opts("groq"));
    expect(lastBody().response_format.type).toBe("json_object");
    expect(lastBody().response_format.json_schema?.strict).not.toBe(true);
  });

  it.each(["mistral", "openrouter", "google", "groq", "ollama", "custom"])(
    "%s gets json_object, never strict",
    async (p) => {
      await callLlm(fakeEp(p), msgs(), opts(p));
      expect(lastBody().response_format).toEqual({ type: "json_object" });
    },
  );

  it.each(["openai", "opencode-zen", "opencode-go"])("%s gets the full strict json_schema shape", async (p) => {
    await callLlm(fakeEp(p), msgs(), opts(p));
    expect(lastBody().response_format).toMatchObject({
      type: "json_schema",
      json_schema: { name: "pr_review", strict: true },
    });
    expect(lastBody().response_format.json_schema.schema.required).toContain("findings");
  });

  it("omits response_format for anthropic, non-strict for ollama, full shape for openai", async () => {
    await callLlm(fakeAnthropicEp(), msgs(), opts("anthropic"));
    expect(lastBody().response_format).toBeUndefined();
    await callLlm(fakeOllamaEp(), msgs(), opts("ollama"));
    expect(lastBody().response_format).toBeDefined();
    expect(lastBody().response_format.type).toBe("json_object");
    expect(lastBody().response_format.json_schema?.strict).not.toBe(true);
    await callLlm(fakeOpenAiEp(), msgs(), opts());
    expect(lastBody().response_format).toMatchObject({
      type: "json_schema",
      json_schema: { name: "pr_review", strict: true },
    });
  });

  it("uses max_completion_tokens for reasoning and max_tokens otherwise", async () => {
    await callLlm(fakeOpenAiEp(), msgs(), { ...opts(), model: "o1" });
    expect(lastBody().max_completion_tokens).toBe(50);
    expect(lastBody().max_tokens).toBeUndefined();
    await callLlm(fakeAnthropicEp(), msgs(), { ...opts("anthropic"), model: "claude-sonnet-5-5" });
    expect(lastBody().max_tokens).toBe(50);
    expect(lastBody().max_completion_tokens).toBeUndefined();
  });

  it("sends Authorization from the endpoint headers and posts to base+path", async () => {
    await callLlm(fakeOpenAiEp(), msgs(), opts());
    expect(calls.at(-1)!.url).toBe("https://openai.test/v1/chat/completions");
    expect((calls.at(-1)!.init.headers as Record<string, string>).Authorization).toBe("Bearer k");
    expect(calls.at(-1)!.init.method).toBe("POST");
  });
});

describe("callLlm response handling", () => {
  it("ignores refusal on anthropic, honors elsewhere", async () => {
    expect(await refusalHonored("anthropic")).toBe(false);
    expect(await refusalHonored("openai")).toBe(true);
    expect(await refusalHonored("ollama")).toBe(true);
  });

  it("strips markdown fences (json and bare) before parse", async () => {
    expect(parseContent("```json\n{\"findings\":[]}\n```")).toEqual({ findings: [] });
    expect(parseContent("```\n{\"findings\":[]}\n```")).toEqual({ findings: [] });
    expect(parseContent('  {"findings":[]}  ')).toEqual({ findings: [] });
  });

  it("parseContent throws InvalidJsonError on non-JSON", () => {
    expect(() => parseContent("not json")).toThrow(InvalidJsonError);
  });

  it("accepts fence-wrapped JSON content end to end", async () => {
    stubFetch(() => json(200, okChat('```json\n{"findings":[]}\n```')));
    expect(await callLlm(fakeOpenAiEp(), msgs(), opts())).toEqual({ ok: true, findings: [] });
  });

  it("maps findings to exactly {severity,file,line?,rule,message,suggestion?}, null to undefined", async () => {
    const content = JSON.stringify({
      findings: [
        { severity: "high", file: "a.ts", line: null, rule: "r1", message: "m1", suggestion: null },
        { severity: "warning", file: "b.ts", line: 7, rule: "r2", message: "m2", suggestion: "fix" },
      ],
    });
    stubFetch(() => json(200, okChat(content)));
    const r = await callLlm(fakeOpenAiEp(), msgs(), opts());
    expect(r).toEqual({
      ok: true,
      findings: [
        { severity: "high", file: "a.ts", rule: "r1", message: "m1" },
        { severity: "warning", file: "b.ts", line: 7, rule: "r2", message: "m2", suggestion: "fix" },
      ],
    });
    expect(r.ok && "line" in r.findings[0]).toBe(false);
    expect(r.ok && "suggestion" in r.findings[0]).toBe(false);
  });

  it("schema-invalid content is invalid-json", async () => {
    stubFetch(() => json(200, okChat(JSON.stringify({ findings: [{ severity: "critical", file: "a", line: null, rule: "r", message: "m", suggestion: null }] }))));
    expect(await callLlm(fakeOpenAiEp(), msgs(), opts())).toMatchObject({ ok: false, reason: "invalid-json" });
    stubFetch(() => json(200, okChat('{"notFindings":[]}')));
    expect(await callLlm(fakeOpenAiEp(), msgs(), opts())).toMatchObject({ ok: false, reason: "invalid-json" });
  });

  it("finish_reason length degrades to invalid-json; content_filter is content-filter", async () => {
    stubFetch(() => json(200, { choices: [{ finish_reason: "length", message: { content: '{"findings":[]}' } }] }));
    expect(await callLlm(fakeOpenAiEp(), msgs(), opts())).toMatchObject({ ok: false, reason: "invalid-json" });
    stubFetch(() => json(200, { choices: [{ finish_reason: "content_filter", message: { content: null } }] }));
    expect(await callLlm(fakeOpenAiEp(), msgs(), opts())).toMatchObject({ ok: false, reason: "content-filter" });
  });

  it("returns no-key without calling fetch", async () => {
    const r = await callLlm(fakeOpenAiEp(), msgs(), { ...opts(), apiKey: "" });
    expect(r).toMatchObject({ ok: false, reason: "no-key" });
    expect(fetchCallCount()).toBe(0);
  });

  it("sampling validation failure is unsupported and makes no request", async () => {
    const r = await callLlm(fakeOpenAiEp(), msgs(), { ...opts(), model: "o1", temperature: 0.5 });
    expect(r).toMatchObject({ ok: false, reason: "unsupported" });
    expect(fetchCallCount()).toBe(0);
  });
});

describe("retry and timeout", () => {
  it("timeout degrades without retry", async () => {
    const r = await callLlmWithTimeout(1);
    expect(r).toMatchObject({ ok: false, reason: "timeout" });
    expect(fetchCallCount()).toBe(1);
  }, 15000);

  it("retries 5xx once then succeeds", async () => {
    stubFetch((_c, n) => (n === 1 ? json(503, { error: "busy" }) : json(200, okChat())));
    expect(await callLlm(fakeOpenAiEp(), msgs(), opts())).toEqual({ ok: true, findings: [] });
    expect(fetchCallCount()).toBe(2);
  }, 15000);

  it("retries 429 honoring Retry-After", async () => {
    stubFetch((_c, n) => (n === 1 ? json(429, {}, { "retry-after": "0" }) : json(200, okChat())));
    expect(await callLlm(fakeOpenAiEp(), msgs(), opts())).toEqual({ ok: true, findings: [] });
    expect(fetchCallCount()).toBe(2);
  });

  it("honors Retry-After: waits the advertised seconds before the retry", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    stubFetch((_c, n) => (n === 1 ? json(429, {}, { "retry-after": "2" }) : json(200, okChat())));
    const p = callLlm(fakeOpenAiEp(), msgs(), { ...opts(), timeoutSeconds: 30 });
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchCallCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchCallCount()).toBe(2);
    expect(await p).toEqual({ ok: true, findings: [] });
  });

  it("clamps an oversized Retry-After to 5s", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    stubFetch((_c, n) => (n === 1 ? json(503, {}, { "retry-after": "60" }) : json(200, okChat())));
    const p = callLlm(fakeOpenAiEp(), msgs(), { ...opts(), timeoutSeconds: 30 });
    await vi.advanceTimersByTimeAsync(4999);
    expect(fetchCallCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchCallCount()).toBe(2);
    expect(await p).toEqual({ ok: true, findings: [] });
  });

  it("without Retry-After, backs off 500ms before the retry", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    stubFetch((_c, n) => (n === 1 ? json(500, {}) : json(200, okChat())));
    const p = callLlm(fakeOpenAiEp(), msgs(), { ...opts(), timeoutSeconds: 30 });
    await vi.advanceTimersByTimeAsync(499);
    expect(fetchCallCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchCallCount()).toBe(2);
    expect(await p).toEqual({ ok: true, findings: [] });
  });

  it.each([
    ["an empty Retry-After", ""],
    ["a whitespace-only Retry-After (Headers strips it to empty)", "   "],
    ["a non-numeric Retry-After", "soon"],
    ["a negative Retry-After", "-5"],
  ])("%s falls back to the 500ms backoff (not 0ms)", async (_label, header) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    stubFetch((_c, n) => (n === 1 ? json(429, {}, { "retry-after": header }) : json(200, okChat())));
    const p = callLlm(fakeOpenAiEp(), msgs(), { ...opts(), timeoutSeconds: 30 });
    await vi.advanceTimersByTimeAsync(499);
    expect(fetchCallCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchCallCount()).toBe(2);
    expect(await p).toEqual({ ok: true, findings: [] });
  });

  it("gives up after one retry on persistent 5xx", async () => {
    stubFetch(() => json(500, {}));
    const r = await callLlm(fakeOpenAiEp(), msgs(), opts());
    expect(r).toMatchObject({ ok: false, reason: "http-error", status: 500 });
    expect(fetchCallCount()).toBe(2);
  }, 15000);

  it("does not retry 4xx", async () => {
    stubFetch(() => json(400, { error: "bad" }));
    const r = await callLlm(fakeOpenAiEp(), msgs(), opts());
    expect(r).toMatchObject({ ok: false, reason: "http-error", status: 400 });
    expect(fetchCallCount()).toBe(1);
  });

  it("network throw is http-error without retry", async () => {
    stubFetch(() => {
      throw new Error("ECONNRESET");
    });
    expect(await callLlm(fakeOpenAiEp(), msgs(), opts())).toMatchObject({ ok: false, reason: "http-error" });
    expect(fetchCallCount()).toBe(1);
  });
});

describe("secret redaction", () => {
  it("never leaks api key in an http-500 result", async () => {
    const r = await callLlmFailing("sk-secret-xyz");
    expect(r).toMatchObject({ ok: false, reason: "http-error" });
    expect(JSON.stringify(r)).not.toContain("sk-secret-xyz");
    expect(JSON.stringify(r)).toContain("[REDACTED]");
  }, 15000);

  it("network throw echoing the key resolves to a redacted result (never rejects)", async () => {
    const r = await callLlmThrowing("sk-secret-xyz");
    expect(r).toMatchObject({ ok: false, reason: "http-error" });
    expect(JSON.stringify(r)).not.toContain("sk-secret-xyz");
    expect(JSON.stringify(r)).toContain("[REDACTED]");
  });

  it("redacts the key before truncating the body snippet (no partial key prefix leaks)", async () => {
    const key = "sk-secret-xyz";
    // `{"error":"` is 10 chars, so the key starts at index 195 and straddles the 200-char cut.
    stubFetch(() => json(400, { error: "a".repeat(185) + key }));
    const r = await callLlm(fakeEp("openai", key), msgs(), { ...opts(), apiKey: key });
    expect(r).toMatchObject({ ok: false, reason: "http-error" });
    expect(JSON.stringify(r)).not.toContain("sk-");
    expect(JSON.stringify(r)).not.toContain(key);
  });
});

describe("timeout bounds the body read", () => {
  it("a stalled response body times out (no retry)", async () => {
    stubFetch(
      (c) =>
        new Response(
          new ReadableStream({
            start(ctrl) {
              c.init.signal?.addEventListener("abort", () =>
                ctrl.error(Object.assign(new Error("aborted"), { name: "AbortError" })),
              );
            },
          }),
          { status: 200 },
        ),
    );
    const r = await callLlm(fakeOpenAiEp(), msgs(), { ...opts(), timeoutSeconds: 1 });
    expect(r).toMatchObject({ ok: false, reason: "timeout" });
    expect(fetchCallCount()).toBe(1);
  }, 15000);
});

describe("findings line coercion", () => {
  it.each([
    [0, undefined],
    [-3, undefined],
    [1.5, undefined],
    ["7", undefined],
    [null, undefined],
    [1, 1],
    [42, 42],
  ])("line %j maps to %j", async (line, expected) => {
    const content = JSON.stringify({
      findings: [{ severity: "info", file: "a.ts", line, rule: "r", message: "m", suggestion: null }],
    });
    stubFetch(() => json(200, okChat(content)));
    const r = await callLlm(fakeOpenAiEp(), msgs(), opts());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.findings[0]!.line).toBe(expected);
      expect("line" in r.findings[0]!).toBe(expected !== undefined);
    }
  });
});

describe("ensureOllama", () => {
  it("healthchecks root then POSTs /api/pull with the model (v1 suffix stripped)", async () => {
    stubFetch((c) =>
      c.url.endsWith("/api/pull")
        ? json(200, { status: "success" })
        : new Response("Ollama is running", { status: 200 }),
    );
    await ensureOllama("http://localhost:11434/v1", "qwen3:8b");
    expect(calls[0]!.url).toBe("http://localhost:11434/");
    expect(calls[1]!.url).toBe("http://localhost:11434/api/pull");
    expect(calls[1]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[1]!.init.body))).toMatchObject({ model: "qwen3:8b", stream: false });
  });

  it("pull 404 throws OllamaMissingError", async () => {
    stubFetch((c) => (c.url.endsWith("/api/pull") ? json(404, { error: "not found" }) : new Response("ok", { status: 200 })));
    await expect(ensureOllama("http://localhost:11434/v1", "nope")).rejects.toBeInstanceOf(OllamaMissingError);
  });

  it("pull body error throws", async () => {
    stubFetch((c) => (c.url.endsWith("/api/pull") ? json(200, { error: "disk full" }) : new Response("ok", { status: 200 })));
    await expect(ensureOllama("http://localhost:11434/v1", "m")).rejects.toThrow(/disk full/);
  });

  it("unreachable server throws the pinned message before pulling", async () => {
    stubFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    await expect(ensureOllama("http://localhost:11434/v1", "m")).rejects.toThrow(
      "Ollama is not reachable at http://localhost:11434: ECONNREFUSED",
    );
    expect(fetchCallCount()).toBe(1);
  });

  it("pull that never answers times out with the timeout message", async () => {
    stubFetch((c) =>
      c.url.endsWith("/api/pull")
        ? new Promise<Response>((_, rej) => {
            c.init.signal?.addEventListener("abort", () =>
              rej(Object.assign(new Error("aborted"), { name: "AbortError" })),
            );
          })
        : new Response("ok", { status: 200 }),
    );
    await expect(ensureOllama("http://localhost:11434/v1", "m", { timeoutSeconds: 1 })).rejects.toThrow(
      'ollama pull "m" timed out after 1s',
    );
  }, 15000);

  it("pull network failure is wrapped and never includes the api key", async () => {
    const key = "sk-secret-xyz";
    stubFetch((c) =>
      c.url.endsWith("/api/pull") ? Promise.reject(new Error(`connect failed (token ${key})`)) : new Response("ok", { status: 200 }),
    );
    const err = await ensureOllama("http://localhost:11434/v1", "m", { apiKey: key }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('ollama pull "m" failed: connect failed (token [REDACTED])');
    expect(String(err)).not.toContain(key);
  });

  it("healthcheck network failure is redacted too", async () => {
    const key = "sk-secret-xyz";
    stubFetch(() => {
      throw new Error(`ECONNRESET ${key}`);
    });
    const err = await ensureOllama("http://localhost:11434/v1", "m", { apiKey: key }).catch((e: unknown) => e);
    expect(String(err)).toContain("[REDACTED]");
    expect(String(err)).not.toContain(key);
  });

  it("non-2xx healthcheck throws the pinned message before pulling", async () => {
    stubFetch(() => new Response("down", { status: 503 }));
    await expect(ensureOllama("http://localhost:11434/v1", "m")).rejects.toThrow(
      "Ollama is not reachable at http://localhost:11434 (HTTP 503)",
    );
    expect(fetchCallCount()).toBe(1);
  });
});

describe("callChatTurn", () => {
  const toolDef = {
    name: "read_file",
    description: "Read a file",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  };

  const conv = (): Conversation => ({ system: "s", user: "u", tools: [toolDef] });
  const turnOpts = (provider = "openai") => opts(provider);
  const toolFlags = { allowTools: true, allowFormat: false };

  /** A chat reply carrying one read_file tool call. */
  const toolReply = (args: string, content: string | null = null) => ({
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          content,
          tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: args } }],
        },
      },
    ],
  });

  it("turn mode sends tools and no response_format", async () => {
    await callChatTurn(fakeOpenAiEp(), conv(), turnOpts(), toolFlags);
    const body = lastBody();
    expect(body.tools[0].function.name).toBe("read_file");
    expect(body.tools[0].function.parameters).toEqual(toolDef.parameters);
    expect("response_format" in body).toBe(false);
  });

  it("translates assistant echo and tool results", async () => {
    const c: Conversation = {
      system: "s",
      user: "u",
      turns: [
        {
          role: "assistant",
          text: "",
          toolCalls: [{ id: "c1", name: "read_file", args: { path: "a.ts" }, rawArgs: '{"path":"a.ts"}' }],
        },
        { role: "tool", id: "c1", name: "read_file", output: "ok" },
      ],
      tools: [toolDef],
    };
    await callChatTurn(fakeOpenAiEp(), c, turnOpts(), toolFlags);
    const body = lastBody();
    expect(body.messages[2].role).toBe("assistant");
    expect(body.messages[2].content).toBeNull();
    expect(body.messages[2].tool_calls[0]).toEqual({
      id: "c1",
      type: "function",
      function: { name: "read_file", arguments: '{"path":"a.ts"}' },
    });
    expect(body.messages[3]).toEqual({ role: "tool", tool_call_id: "c1", content: "ok" });
  });

  it("parses tool_calls into AgentReply with rawArgs", async () => {
    stubFetch(() => json(200, toolReply('{"path":"a.ts"}')));
    const r = await callChatTurn(fakeOpenAiEp(), conv(), turnOpts(), toolFlags);
    expect(r).toEqual({
      ok: true,
      text: "",
      toolCalls: [{ id: "c1", name: "read_file", args: { path: "a.ts" }, rawArgs: '{"path":"a.ts"}' }],
    });
  });

  it("keeps text when text and tool calls arrive together", async () => {
    stubFetch(() => json(200, toolReply('{"path":"a.ts"}', "here you go")));
    const r = await callChatTurn(fakeOpenAiEp(), conv(), turnOpts(), toolFlags);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toBe("here you go");
      expect(r.toolCalls).toHaveLength(1);
    }
  });

  it("null content with tool calls is not an error", async () => {
    stubFetch(() => json(200, toolReply('{"path":"a.ts"}', null)));
    const r = await callChatTurn(fakeOpenAiEp(), conv(), turnOpts(), toolFlags);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe("");
  });

  it("malformed tool arguments do not throw (args undefined)", async () => {
    stubFetch(() => json(200, toolReply("{not json")));
    const r = await callChatTurn(fakeOpenAiEp(), conv(), turnOpts(), toolFlags);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.toolCalls[0]!.args).toBeUndefined();
      expect(r.toolCalls[0]!.rawArgs).toBe("{not json");
    }
  });

  it("refusal and finish_reason=length keep single-shot mappings in turn mode", async () => {
    stubFetch(() => json(200, { choices: [{ finish_reason: "stop", message: { content: "hi", refusal: "x" } }] }));
    expect(await callChatTurn(fakeOpenAiEp(), conv(), turnOpts(), toolFlags)).toEqual({
      ok: false,
      result: { ok: false, reason: "content-filter", detail: "model refused the request" },
    });
    stubFetch(() => json(200, { choices: [{ finish_reason: "length", message: { content: "hi" } }] }));
    expect(await callChatTurn(fakeOpenAiEp(), conv(), turnOpts(), toolFlags)).toEqual({
      ok: false,
      result: { ok: false, reason: "invalid-json", detail: "response truncated (finish_reason=length)" },
    });
  });
});
