import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as core from "@actions/core";
import {
  resolveEndpoint,
  buildEndpointForStyle,
  UnsupportedModelError,
  catalogProtocolFor,
  checkModelListed,
} from "../src/providers.js";

vi.mock("@actions/core", () => ({ warning: vi.fn() }));

const base = { llmBaseUrl: "", llmApiStyle: "auto", llmPath: "", llmApiKey: "k", prNumber: 1 } as const;

beforeEach(() => {
  vi.mocked(core.warning).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("resolveEndpoint", () => {
  it("base and path are separate for zen", () => {
    const r = resolveEndpoint({ ...base, llmProvider: "opencode-zen", llmModel: "glm-5.3-flash" });
    expect(r.baseUrl).toBe("https://opencode.ai/zen/v1");
    expect(r.path).toBe("/chat/completions");
  });

  // Spec §9.5: auto consults no map — it resolves the chat default, and the
  // probe (callWithProbe) discovers the working style from 400/404 errors.
  it("auto resolves openai-chat for every provider (the probe decides the style)", () => {
    for (const [provider, model] of [
      ["opencode-zen", "qwen3.8-max"],
      ["opencode-go", "qwen3.8-max"],
      ["opencode-zen", "gpt-6-luna"],
      ["opencode-zen", "claude-sonnet-5-5"],
      ["opencode-zen", "gemini-3.8-flash"],
    ] as const) {
      const r = resolveEndpoint({ ...base, llmProvider: provider, llmModel: model });
      expect(r.apiStyle).toBe("openai-chat");
      expect(r.path).toBe("/chat/completions");
    }
  });

  it("zen sends no session header, go does", () => {
    const z = resolveEndpoint({ ...base, llmProvider: "opencode-zen", llmModel: "deepseek-v4.1-flash" });
    expect(z.headers["User-Agent"]).toContain("pr-reviewer");
    expect(z.headers["x-opencode-session"]).toBeUndefined();
    const g = resolveEndpoint({ ...base, llmProvider: "opencode-go", llmModel: "glm-5.3-flash" });
    expect(g.headers["x-opencode-session"]).toBe("pr-1");
  });

  it("llm_path to non-chat without v2 style throws path-only error", () => {
    expect(() => resolveEndpoint({ ...base, llmProvider: "custom", llmBaseUrl: "https://x", llmModel: "m", llmPath: "/messages" })).toThrow(/path-only/);
  });

  it("explicit v2 api_style is functional and picks the adapter path", () => {
    expect(resolveEndpoint({ ...base, llmProvider: "openai", llmModel: "m", llmApiStyle: "anthropic-messages" }).path).toBe("/messages");
  });

  // R3: the /openai-suffix strip is surfaced when it rewrites a USER-SUPPLIED base URL.
  it("warns when a user-supplied custom base ending in /openai is rewritten for google-models", () => {
    const r = resolveEndpoint({
      ...base,
      llmProvider: "custom",
      llmBaseUrl: "https://x/v1beta/openai",
      llmModel: "gemini-x",
      llmApiStyle: "google-models",
    });
    expect(r.baseUrl).toBe("https://x/v1beta");
    expect(core.warning).toHaveBeenCalledTimes(1);
    const msg = vi.mocked(core.warning).mock.calls[0][0] as string;
    expect(msg).toContain("https://x/v1beta/openai");
    expect(msg).toContain("https://x/v1beta");
  });

  it("preset google base rewrite (not user-supplied) does not warn", () => {
    resolveEndpoint({ ...base, llmProvider: "google", llmModel: "gemini-x", llmApiStyle: "google-models" });
    expect(core.warning).not.toHaveBeenCalled();
  });

  // Explicit marker: resolveEndpoint warns iff the base came from the user AND was stripped.
  it("resolveEndpoint honors an explicit userBase=false even with a non-empty llm_base_url", () => {
    const r = resolveEndpoint({
      ...base,
      llmProvider: "custom",
      llmBaseUrl: "https://x/v1beta/openai",
      llmModel: "gemini-x",
      llmApiStyle: "google-models",
      userBase: false,
    });
    expect(r.baseUrl).toBe("https://x/v1beta");
    expect(core.warning).not.toHaveBeenCalled();
  });

  it("resolveEndpoint honors an explicit userBase=true (warns on the strip)", () => {
    const r = resolveEndpoint({
      ...base,
      llmProvider: "custom",
      llmBaseUrl: "https://x/v1beta/openai",
      llmModel: "gemini-x",
      llmApiStyle: "google-models",
      userBase: true,
    });
    expect(r.baseUrl).toBe("https://x/v1beta");
    expect(core.warning).toHaveBeenCalledTimes(1);
  });

  it("prNumber null ok, go without number omits session header", () => {
    expect(resolveEndpoint({ ...base, llmProvider: "openai", llmModel: "m", prNumber: null }).headers["x-opencode-session"]).toBeUndefined();
    expect(resolveEndpoint({ ...base, llmProvider: "opencode-go", llmModel: "glm-5.3-flash", prNumber: null }).headers["x-opencode-session"]).toBeUndefined();
    const g = resolveEndpoint({ ...base, llmProvider: "opencode-go", llmModel: "glm-5.3-flash" });
    expect(g.headers["x-opencode-session"]).toBe("pr-1");
  });

  // F9: preset table, all nine presets.
  it.each([
    ["openai", "https://api.openai.com/v1"],
    ["anthropic", "https://api.anthropic.com/v1"],
    ["google", "https://generativelanguage.googleapis.com/v1beta/openai"],
    ["groq", "https://api.groq.com/openai/v1"],
    ["mistral", "https://api.mistral.ai/v1"],
    ["openrouter", "https://openrouter.ai/api/v1"],
    ["ollama", "http://localhost:11434/v1"],
    ["opencode-zen", "https://opencode.ai/zen/v1"],
    ["opencode-go", "https://opencode.ai/zen/go/v1"],
  ] as const)("preset %s baseUrl is exact and path-free", (provider, expected) => {
    const r = resolveEndpoint({ ...base, llmProvider: provider, llmModel: "m" });
    expect(r.baseUrl).toBe(expected);
    expect(r.path).toBe("/chat/completions");
  });

  it("custom requires llm_base_url", () => {
    expect(() => resolveEndpoint({ ...base, llmProvider: "custom", llmModel: "m" })).toThrow(/requires llm_base_url/);
    expect(resolveEndpoint({ ...base, llmProvider: "custom", llmBaseUrl: "https://c.example/v1/", llmModel: "m" }).baseUrl).toBe("https://c.example/v1");
  });

  // Spec §9.5: the "explicit openai-chat on a non-chat pair" fail-fast is gone —
  // an explicit openai-chat is honored on every pair, chat body sent as-is.
  it("explicit openai-chat is honored on every pair (no map, no fail-fast)", () => {
    expect(
      resolveEndpoint({ ...base, llmProvider: "opencode-zen", llmModel: "gpt-6-luna", llmApiStyle: "openai-chat" }).path,
    ).toBe("/chat/completions");
    expect(
      resolveEndpoint({ ...base, llmProvider: "opencode-go", llmModel: "qwen3.8-max", llmApiStyle: "openai-chat" }).path,
    ).toBe("/chat/completions");
  });

  it("explicit openai-chat on a chat pair resolves", () => {
    expect(resolveEndpoint({ ...base, llmProvider: "opencode-zen", llmModel: "qwen3.8-max", llmApiStyle: "openai-chat" }).path).toBe("/chat/completions");
  });

  // F12 (v2): explicit v2 styles resolve to their adapter path.
  it.each([
    ["openai-responses", "/responses"],
    ["google-models", "/models/m:generateContent"],
  ] as const)("explicit %s resolves with path %s", (style, path) => {
    expect(resolveEndpoint({ ...base, llmProvider: "openai", llmModel: "m", llmApiStyle: style }).path).toBe(path);
  });

  // F12: custom-path needs llm_path; plain Error (R2).
  it("explicit custom-path with empty llm_path throws plain Error", () => {
    let caught: unknown;
    try {
      resolveEndpoint({ ...base, llmProvider: "custom", llmBaseUrl: "https://x", llmModel: "m", llmApiStyle: "custom-path" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(UnsupportedModelError);
    expect((caught as Error).message).toMatch(/requires llm_path/);
  });

  // F5: path-segment matching.
  it("path containing /models mid-path does NOT throw path-only", () => {
    const r = resolveEndpoint({ ...base, llmProvider: "openai", llmModel: "m", llmPath: "/openai/models/chat/completions" });
    expect(r.path).toBe("/openai/models/chat/completions");
  });

  it("bare messages (no leading slash) throws path-only after normalization", () => {
    expect(() => resolveEndpoint({ ...base, llmProvider: "custom", llmBaseUrl: "https://x", llmModel: "m", llmPath: "messages" })).toThrow(/path-only/);
  });

  it("path without leading slash joins with one slash", () => {
    const r = resolveEndpoint({ ...base, llmProvider: "custom", llmBaseUrl: "https://x", llmModel: "m", llmPath: "chat/completions" });
    expect(r.path).toBe("/chat/completions");
    expect(r.baseUrl + r.path).toBe("https://x/chat/completions");
  });

  it("returned path strips #fragment and ?query", () => {
    expect(resolveEndpoint({ ...base, llmProvider: "custom", llmBaseUrl: "https://x", llmModel: "m", llmPath: "/chat/completions#x" }).path).toBe("/chat/completions");
    expect(resolveEndpoint({ ...base, llmProvider: "custom", llmBaseUrl: "https://x", llmModel: "m", llmPath: "/chat/completions?a=1" }).path).toBe("/chat/completions");
  });

  it("bare query-bearing messages?x=1 throws path-only", () => {
    expect(() => resolveEndpoint({ ...base, llmProvider: "custom", llmBaseUrl: "https://x", llmModel: "m", llmPath: "messages?x=1" })).toThrow(/path-only/);
  });

  it("path-only message quotes raw (query stripped) and normalized path, never the query", () => {
    let msg = "";
    try {
      resolveEndpoint({ ...base, llmProvider: "custom", llmBaseUrl: "https://x", llmModel: "m", llmPath: "messages?key=SECRET" });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('llm_path "messages" normalizes to "/messages"');
    expect(msg).not.toContain("SECRET");
    expect(msg).not.toContain("key=");
  });

  it("warns once naming the stripped query string, without its value", () => {
    resolveEndpoint({ ...base, llmProvider: "custom", llmBaseUrl: "https://x", llmModel: "m", llmPath: "/chat/completions?a=SECRET" });
    expect(core.warning).toHaveBeenCalledTimes(1);
    const msg = vi.mocked(core.warning).mock.calls[0][0] as string;
    expect(msg).toContain("query string");
    expect(msg).not.toContain("SECRET");
  });

  it("warns naming the stripped fragment", () => {
    resolveEndpoint({ ...base, llmProvider: "custom", llmBaseUrl: "https://x", llmModel: "m", llmPath: "/chat/completions#frag" });
    expect(core.warning).toHaveBeenCalledTimes(1);
    expect(vi.mocked(core.warning).mock.calls[0][0]).toContain("fragment");
  });

  it("no warning for a clean path", () => {
    resolveEndpoint({ ...base, llmProvider: "custom", llmBaseUrl: "https://x", llmModel: "m", llmPath: "/chat/completions" });
    expect(core.warning).not.toHaveBeenCalled();
  });

  it('"/messages#x" throws path-only (fragment stripped)', () => {
    expect(() => resolveEndpoint({ ...base, llmProvider: "custom", llmBaseUrl: "https://x", llmModel: "m", llmPath: "/messages#x" })).toThrow(/path-only/);
  });

  it("joins baseUrl and path with exactly one slash", () => {
    const r = resolveEndpoint({ ...base, llmProvider: "custom", llmBaseUrl: "https://x/v1/", llmModel: "m", llmPath: "/chat/completions" });
    expect(r.baseUrl + r.path).toBe("https://x/v1/chat/completions");
  });

  it("/v1/chat/completions resolves", () => {
    expect(resolveEndpoint({ ...base, llmProvider: "custom", llmBaseUrl: "https://x", llmModel: "m", llmPath: "/v1/chat/completions" }).path).toBe("/v1/chat/completions");
  });

  it("/openai/models/chat/completions resolves (last segment is completions)", () => {
    expect(resolveEndpoint({ ...base, llmProvider: "custom", llmBaseUrl: "https://x", llmModel: "m", llmPath: "/openai/models/chat/completions" }).path).toBe("/openai/models/chat/completions");
  });

  it("/v1/messages throws path-only (last segment)", () => {
    expect(() => resolveEndpoint({ ...base, llmProvider: "custom", llmBaseUrl: "https://x", llmModel: "m", llmPath: "/v1/messages" })).toThrow(/path-only/);
  });

  it.each(["/messages", "/responses", "/models", "/v1/responses", "/models?x=1", "/v1/messages/", "/messages/?x=1"])("path %s throws path-only", (p) => {
    expect(() => resolveEndpoint({ ...base, llmProvider: "custom", llmBaseUrl: "https://x", llmModel: "m", llmPath: p })).toThrow(/path-only/);
  });

  it("/messages/x resolves (last segment is x)", () => {
    expect(resolveEndpoint({ ...base, llmProvider: "custom", llmBaseUrl: "https://x", llmModel: "m", llmPath: "/messages/x" }).path).toBe("/messages/x");
  });
});

describe("buildEndpointForStyle", () => {
  // R3-warning fix: the probe's synthetic base must not read as user-supplied.
  it("a preset-derived base stripped for google-models does NOT warn (probe misfire)", () => {
    const r = buildEndpointForStyle(
      "google",
      "gemini-x",
      "https://generativelanguage.googleapis.com/v1beta/openai",
      "k",
      "google-models",
    );
    expect(r.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta");
    expect(r.path).toBe("/models/gemini-x:generateContent");
    expect(core.warning).not.toHaveBeenCalled();
  });

  it("a user-supplied base stripped for google-models DOES warn (userBase: true)", () => {
    const r = buildEndpointForStyle("custom", "gemini-x", "https://x/v1beta/openai", "k", "google-models", null, true);
    expect(r.baseUrl).toBe("https://x/v1beta");
    expect(core.warning).toHaveBeenCalledTimes(1);
    const msg = vi.mocked(core.warning).mock.calls[0][0] as string;
    expect(msg).toContain("https://x/v1beta/openai");
    expect(msg).toContain("https://x/v1beta");
  });

  it("no strip and no warning for a base without the /openai suffix", () => {
    const r = buildEndpointForStyle("opencode-go", "m", "https://opencode.ai/zen/go/v1", "k", "openai-responses", 7);
    expect(r.baseUrl).toBe("https://opencode.ai/zen/go/v1");
    expect(r.path).toBe("/responses");
    expect(r.headers["x-opencode-session"]).toBe("pr-7");
    expect(core.warning).not.toHaveBeenCalled();
  });
});

describe("native model discovery", () => {
  it("catalogProtocolFor maps provider + style to the catalog protocol", () => {
    expect(catalogProtocolFor("google", "google-models")).toBe("google");
    expect(catalogProtocolFor("custom", "google-models")).toBe("google");
    expect(catalogProtocolFor("anthropic", "anthropic-messages")).toBe("anthropic");
    expect(catalogProtocolFor("custom", "anthropic-messages")).toBe("anthropic");
    expect(catalogProtocolFor("opencode-go", "google-models")).toBe("openai");
    expect(catalogProtocolFor("opencode-zen", "openai-chat")).toBe("openai");
    expect(catalogProtocolFor("ollama", "openai-chat")).toBe("openai");
  });

  it("checkModelListed reads a google-native models[].name catalog and follows pageToken", async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (u: string, _init?: RequestInit) => {
      urls.push(u);
      return urls.length === 1
        ? new Response(JSON.stringify({ models: [{ name: "models/other" }], nextPageToken: "t" }), { status: 200 })
        : new Response(JSON.stringify({ models: [{ name: "models/wanted" }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await checkModelListed("https://g/v1beta", "wanted", "K", "google")).toEqual({ status: "listed" });
    expect(urls[1]).toBe("https://g/v1beta/models?pageToken=t&pageSize=1000");
    const h = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(h["x-goog-api-key"]).toBe("K");
    expect(h.Authorization).toBeUndefined();
    expect(h["User-Agent"]).toBe("pr-reviewer/1.0");
  });

  it("checkModelListed sends x-api-key + anthropic-version and follows after_id", async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (u: string, _init?: RequestInit) => {
      urls.push(u);
      return urls.length === 1
        ? new Response(JSON.stringify({ data: [{ id: "other" }], has_more: true, last_id: "other" }), { status: 200 })
        : new Response(JSON.stringify({ data: [{ id: "wanted" }], has_more: false }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await checkModelListed("https://a/v1", "wanted", "K", "anthropic")).toEqual({ status: "listed" });
    expect(urls[1]).toBe("https://a/v1/models?after_id=other&limit=1000");
    const h = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(h["x-api-key"]).toBe("K");
    expect(h["anthropic-version"]).toBe("2023-06-01");
    expect(h.Authorization).toBeUndefined();
    expect(h["User-Agent"]).toBe("pr-reviewer/1.0");
  });

  it("checkModelListed reads an OpenAI data[].id catalog with Bearer", async () => {
    const fetchMock = vi.fn(async (_u: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ data: [{ id: "m" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await checkModelListed("https://o/v1", "m", "K", "openai")).toEqual({ status: "listed" });
    const h = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(h.Authorization).toBe("Bearer K");
    expect(h["User-Agent"]).toBe("pr-reviewer/1.0");
  });

  it("checkModelListed returns absent only for a non-empty catalog missing the model", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "other" }] }), { status: 200 })));
    expect(await checkModelListed("https://o/v1", "wanted", "K", "openai")).toEqual({ status: "absent" });
  });

  it("checkModelListed returns unknown for HTTP errors, invalid JSON, bad shape, empty catalog, and timeout", async () => {
    const cases: Array<() => Response | Promise<Response>> = [
      () => new Response("nope", { status: 404 }),
      () => new Response("boom", { status: 500 }),
      () => new Response("{not json", { status: 200 }),
      () => new Response(JSON.stringify({ nope: [] }), { status: 200 }),
      () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
    ];
    for (const c of cases) {
      vi.stubGlobal("fetch", vi.fn(async () => c()));
      const result = await checkModelListed("https://o/v1", "m", "K", "openai");
      expect(result.status).toBe("unknown");
      expect(result.detail).toEqual(expect.any(String));
    }
    vi.stubGlobal("fetch", vi.fn((_u: string, init?: RequestInit) =>
      new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")))),
    ));
    vi.useFakeTimers();
    const p = checkModelListed("https://o/v1", "m", "K", "openai");
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await p).status).toBe("unknown");
    vi.useRealTimers();
  });
});
