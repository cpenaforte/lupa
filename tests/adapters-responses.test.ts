import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { callResponses, callResponsesTurn } from "../src/adapters/responses.js";
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

/** Minimal completed Responses-API envelope carrying one output_text part. */
const okResponses = (text: string, extra: Record<string, unknown> = {}) => ({
  status: "completed",
  output: [{ type: "message", content: [{ type: "output_text", text }] }],
  ...extra,
});

function lastBody(): Record<string, unknown> {
  return JSON.parse(String(calls.at(-1)!.init.body)) as Record<string, unknown>;
}

/** Endpoint mirroring resolveEndpoint for the responses path. */
function fakeResponsesEp(key = "k"): ResolvedEndpoint {
  return {
    baseUrl: "https://opencode.ai/zen/v1",
    path: "/responses",
    headers: { Authorization: `Bearer ${key}`, "User-Agent": "pr-reviewer/1.0" },
    apiStyle: "openai-responses",
  };
}

function msgs(): { system: string; user: string } {
  return { system: "s", user: '{"findings":[]}' };
}

function opts() {
  return { model: "gpt-6-luna", apiKey: "k", maxTokens: 50, timeoutSeconds: 5 };
}

beforeEach(() => {
  calls = [];
  stubFetch(() => json(200, okResponses('{"findings":[]}')));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------- tests ----------

describe("callResponses", () => {
  it("posts input array + max_output_tokens + strict format", async () => {
    const r = await callResponses(fakeResponsesEp(), msgs(), opts());
    expect(r).toEqual({ ok: true, findings: [] });
    expect(calls.at(-1)!.url).toBe("https://opencode.ai/zen/v1/responses");
    const body = lastBody();
    expect(body.model).toBe("gpt-6-luna");
    expect(body.input).toEqual([
      { role: "system", content: "s" },
      { role: "user", content: '{"findings":[]}' },
    ]);
    expect(body.max_output_tokens).toBe(50);
    expect(body.text).toEqual({
      format: {
        type: "json_schema",
        name: "pr_review",
        schema: PR_REVIEW_SCHEMA.schema,
        strict: true,
      },
    });
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
  });

  it("falls back without format on 400", async () => {
    stubFetch((_c, n) =>
      n === 1 ? json(400, { error: "unsupported format" }) : json(200, okResponses('{"findings":[]}')),
    );
    const r = await callResponses(fakeResponsesEp(), msgs(), opts());
    expect(r).toEqual({ ok: true, findings: [] });
    expect(calls.length).toBe(2);
    expect(JSON.parse(String(calls[0]!.init.body)).text).toBeDefined();
    expect(JSON.parse(String(calls[1]!.init.body))).not.toHaveProperty("text");
  });

  it("joins output_text parts and parses findings", async () => {
    stubFetch(() =>
      json(200, {
        status: "completed",
        output: [
          { type: "message", content: [{ type: "output_text", text: '{"findings":[' }] },
          { type: "message", content: [{ type: "text", text: "]}" }] },
        ],
      }),
    );
    expect(await callResponses(fakeResponsesEp(), msgs(), opts())).toEqual({ ok: true, findings: [] });
  });

  it("refusal item → content-filter skip; incomplete → degrade", async () => {
    stubFetch(() =>
      json(200, {
        status: "completed",
        output: [{ type: "message", content: [{ type: "refusal", refusal: "sorry" }] }],
      }),
    );
    expect(await callResponses(fakeResponsesEp(), msgs(), opts())).toMatchObject({
      ok: false,
      reason: "content-filter",
    });
    stubFetch(() =>
      json(200, {
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [{ type: "message", content: [{ type: "output_text", text: '{"findings":[]}' }] }],
      }),
    );
    expect(await callResponses(fakeResponsesEp(), msgs(), opts())).toMatchObject({
      ok: false,
      reason: "invalid-json",
    });
  });

  it("retries once on 429/5xx and degrades on timeout without retry", async () => {
    // 429 → one retry (Retry-After: 0 keeps the backoff instant).
    stubFetch((_c, n) =>
      n === 1 ? json(429, { error: "rate limited" }, { "retry-after": "0" }) : json(200, okResponses('{"findings":[]}')),
    );
    expect(await callResponses(fakeResponsesEp(), msgs(), opts())).toEqual({ ok: true, findings: [] });
    expect(calls.length).toBe(2);

    // Persistent 5xx → exactly one retry (two calls, never three).
    stubFetch(() => json(503, { error: "unavailable" }, { "retry-after": "0" }));
    expect(await callResponses(fakeResponsesEp(), msgs(), opts())).toMatchObject({
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
    expect(
      await callResponses(fakeResponsesEp(), msgs(), { ...opts(), timeoutSeconds: 0.05 }),
    ).toMatchObject({ ok: false, reason: "timeout" });
    expect(timeoutFetch).toHaveBeenCalledTimes(1);
    expect(calls.length).toBe(1);
  });

  it("reasoning model maps max_completion_tokens→max_output_tokens", async () => {
    await callResponses(fakeResponsesEp(), msgs(), { ...opts(), model: "gpt-6-luna" });
    const body = lastBody();
    expect(body.max_output_tokens).toBe(50);
    expect(body.max_completion_tokens).toBeUndefined();
    expect(body.max_tokens).toBeUndefined();
    await callResponses(fakeResponsesEp(), msgs(), { ...opts(), model: "deepseek-v4.1-flash" });
    const body2 = lastBody();
    expect(body2.max_output_tokens).toBe(50);
    expect(body2.max_completion_tokens).toBeUndefined();
    expect(body2.max_tokens).toBeUndefined();
  });
});

describe("callResponsesTurn", () => {
  const toolDef = {
    name: "read_file",
    description: "Read a file",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  };

  const conv = (): Conversation => ({ system: "s", user: "u", tools: [toolDef] });
  const turnOpts = () => ({ model: "gpt-6-luna", apiKey: "k", maxTokens: 50, timeoutSeconds: 5 });
  const toolFlags = { allowTools: true, allowFormat: false };

  it("turn mode sends flat tools and no text.format", async () => {
    await callResponsesTurn(fakeResponsesEp(), conv(), turnOpts(), toolFlags);
    const body: any = lastBody();
    expect(body.tools[0]).toEqual({
      type: "function",
      name: "read_file",
      description: "Read a file",
      parameters: toolDef.parameters,
    });
    expect("text" in body).toBe(false);
  });

  it("translates function_call echo and function_call_output", async () => {
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
    await callResponsesTurn(fakeResponsesEp(), c, turnOpts(), toolFlags);
    const body: any = lastBody();
    expect(body.input[2]).toEqual({
      type: "function_call",
      call_id: "c1",
      name: "read_file",
      arguments: '{"path":"a.ts"}',
    });
    expect(body.input[3]).toEqual({ type: "function_call_output", call_id: "c1", output: "ok" });
  });

  it("parses output function_call items with call_id", async () => {
    stubFetch(() =>
      json(200, {
        status: "completed",
        output: [{ type: "function_call", call_id: "c1", name: "read_file", arguments: '{"path":"a.ts"}' }],
      }),
    );
    const r = await callResponsesTurn(fakeResponsesEp(), conv(), turnOpts(), toolFlags);
    expect(r).toEqual({
      ok: true,
      text: "",
      toolCalls: [{ id: "c1", name: "read_file", args: { path: "a.ts" }, rawArgs: '{"path":"a.ts"}' }],
      rawItems: [{ type: "function_call", call_id: "c1", name: "read_file", arguments: '{"path":"a.ts"}' }],
    });
  });

  it("text plus function_call in one output parses both", async () => {
    stubFetch(() =>
      json(200, {
        status: "completed",
        output: [
          { type: "message", content: [{ type: "output_text", text: "thinking" }] },
          { type: "function_call", call_id: "c1", name: "read_file", arguments: '{"path":"a.ts"}' },
        ],
      }),
    );
    const r = await callResponsesTurn(fakeResponsesEp(), conv(), turnOpts(), toolFlags);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toBe("thinking");
      expect(r.toolCalls).toHaveLength(1);
      expect(r.toolCalls[0]!.id).toBe("c1");
    }
  });

  it("echoes raw output items verbatim so reasoning items survive the next turn", async () => {
    const reasoning = { type: "reasoning", id: "rs_1", status: "completed", summary: [] };
    const fc = { type: "function_call", call_id: "c1", name: "read_file", arguments: '{"path":"a.ts"}' };
    stubFetch(() => json(200, { status: "completed", output: [reasoning, fc] }));

    const first = await callResponsesTurn(fakeResponsesEp(), conv(), turnOpts(), toolFlags);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Docs pattern: the next turn echoes response.output verbatim (id/status included).
    const next: Conversation = {
      system: "s",
      user: "u",
      turns: [
        { role: "assistant", text: first.text, toolCalls: first.toolCalls, rawItems: first.rawItems },
        { role: "tool", id: "c1", name: "read_file", output: "ok" },
      ],
      tools: [toolDef],
    };
    await callResponsesTurn(fakeResponsesEp(), next, turnOpts(), toolFlags);
    const body: any = lastBody();
    expect(body.input[2]).toEqual(reasoning);
    expect(body.input[3]).toEqual(fc);
    expect(body.input[4]).toEqual({ type: "function_call_output", call_id: "c1", output: "ok" });
  });
});
