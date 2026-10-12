import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as core from "@actions/core";
import {
  callWithProbeAgent,
  callByStyleAgent,
  resetProbeMemo,
  resetToolsMemo,
  PROBE_ORDER,
} from "../src/llm.js";
import { buildEndpointForStyle } from "../src/providers.js";
import type { Conversation } from "../src/agent-types.js";
import type { ToolContext } from "../src/agent-tools.js";

vi.mock("@actions/core", () => ({ warning: vi.fn(), info: vi.fn() }));

// Records every runAgent budget seen through the agent-mode probe so the
// shared-deadline test can pin that all probed styles receive the same
// absolute deadlineMs. Delegates to the real runAgent; existing tests are
// unaffected.
vi.mock("../src/agent.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agent.js")>();
  const budgets = ((globalThis as Record<string, unknown>)["__probeBudgets"] ??= []) as Array<
    Parameters<typeof actual.runAgent>[2]
  >;
  return {
    ...actual,
    runAgent: (...args: Parameters<typeof actual.runAgent>) => {
      budgets.push(args[2]);
      return actual.runAgent(...args);
    },
  };
});

function probeBudgets(): Array<{ deadlineMs?: number }> {
  return (globalThis as Record<string, unknown>)["__probeBudgets"] as Array<{ deadlineMs?: number }>;
}

// ---------- helpers ----------

const FINDING = { severity: "warning", file: "src/a.ts", line: 2, rule: "logic", message: "m", suggestion: "sug" };
const FINDINGS_JSON = JSON.stringify({ findings: [FINDING] });

const CHAT_OK = { choices: [{ finish_reason: "stop", message: { content: FINDINGS_JSON } }] };
const RESPONSES_OK = {
  status: "completed",
  output: [{ type: "message", content: [{ type: "output_text", text: FINDINGS_JSON }] }],
};
const TOOL_CALL_CHAT = {
  choices: [
    {
      finish_reason: "stop",
      message: {
        content: "",
        tool_calls: [{ id: "c1", type: "function", function: { name: "bogus", arguments: "{}" } }],
      },
    },
  ],
};

const ZEN = "https://opencode.ai/zen/v1";
const AGENT_O = { maxTokens: 50, timeoutSeconds: 5, maxTurns: 5, maxSeconds: 120 };
const TOOL_CTX: ToolContext = { roots: { self: "/tmp" } };

function conv(): Conversation {
  return {
    system: "s",
    user: "u",
    tools: [{ name: "bogus", description: "d", parameters: { type: "object" } }],
  };
}

function bodies(): string[] {
  return vi
    .mocked(fetch)
    .mock.calls.map((c) => String(((c[1] as RequestInit | undefined)?.body ?? "") as unknown as string));
}

function warnings(): string[] {
  return vi.mocked(core.warning).mock.calls.map((c) => String(c[0]));
}

beforeEach(() => {
  // Test-only: neither in-process memo may leak across tests.
  resetProbeMemo();
  resetToolsMemo();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------- task 30: probe integration + TOOLS_MEMO fallback ----------

describe("callWithProbeAgent", () => {
  it("auto: chat 404 → responses succeeds with tools (memoized style)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
        return new Response(JSON.stringify(RESPONSES_OK), { status: 200 });
      }),
    );
    const r = await callWithProbeAgent("opencode-zen", "ap1-model", ZEN, "k", conv(), AGENT_O, TOOL_CTX);
    expect(r.result).toEqual({ ok: true, findings: [FINDING] });
    expect(r.via).toBe("openai-responses");
    // The chat attempt went out with tools attached.
    expect(bodies()[0]).toContain('"tools"');
    const n = vi.mocked(fetch).mock.calls.length;
    // Memoized: the next call goes straight to the winning style.
    const r2 = await callWithProbeAgent("opencode-zen", "ap1-model", ZEN, "k", conv(), AGENT_O, TOOL_CTX);
    expect(r2.result).toEqual({ ok: true, findings: [FINDING] });
    expect(r2.via).toBe("openai-responses");
    expect(vi.mocked(fetch).mock.calls.length).toBe(n + 1);
    expect(String(vi.mocked(fetch).mock.calls.at(-1)?.[0])).toBe(`${ZEN}/responses`);
  });

  it("400 with tools then no-tools retry ok → single-shot fallback result and TOOLS_MEMO set", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL, init?: unknown) => {
        const body = String(((init as RequestInit | undefined)?.body ?? "") as unknown as string);
        if (body.includes('"tools"')) return new Response("bad tools", { status: 400 });
        return new Response(JSON.stringify(CHAT_OK), { status: 200 });
      }),
    );
    const r = await callWithProbeAgent("opencode-zen", "ap2-model", ZEN, "k", conv(), AGENT_O, TOOL_CTX);
    expect(r.result).toEqual({ ok: true, findings: [FINDING] });
    expect(r.via).toBe("openai-chat");
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    // Next call for the same model: single-shot, no tools attached.
    vi.mocked(fetch).mockClear();
    const r2 = await callWithProbeAgent("opencode-zen", "ap2-model", ZEN, "k", conv(), AGENT_O, TOOL_CTX);
    // Single-shot fallback goes through callLlm, so it carries verdicts (empty here).
    expect(r2.result).toEqual({
      ok: true,
      findings: [FINDING],
      verdicts: { pairs: [], links: [], malformed: 0 },
    });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    expect(bodies()[0]).not.toContain('"tools"');
    expect(vi.mocked(core.info)).toHaveBeenCalledWith("agent tools unsupported for this model: using single-shot");
  });

  it("400 with tools then no-tools retry 400 → advances to the next style", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.endsWith("/chat/completions")) return new Response("bad request", { status: 400 });
        if (u.endsWith("/responses")) return new Response(JSON.stringify(RESPONSES_OK), { status: 200 });
        return new Response("not found", { status: 404 });
      }),
    );
    const r = await callWithProbeAgent("opencode-zen", "ap3-model", ZEN, "k", conv(), AGENT_O, TOOL_CTX);
    expect(r.result).toEqual({ ok: true, findings: [FINDING] });
    expect(r.via).toBe("openai-responses");
    // Chat tried with tools and once more without, then the probe moved on.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
  });

  it("mid-loop 400 does not advance the style", async () => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        n += 1;
        if (n === 1) return new Response(JSON.stringify(TOOL_CALL_CHAT), { status: 200 });
        return new Response("bad request", { status: 400 });
      }),
    );
    const r = await callWithProbeAgent("opencode-zen", "ap4-model", ZEN, "k", conv(), AGENT_O, TOOL_CTX);
    expect(r.result.ok).toBe(false);
    expect(r.result.ok === false && r.result.reason).toBe("http-error");
    expect(r.result.ok === false && r.result.detail).toContain("HTTP 400");
    expect(r.via).toBe("openai-chat");
    // Tool turn + failed second turn, both on the same style: no advance.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it("explicit style makes exactly one attempt with tools", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not found", { status: 404 })),
    );
    const r = await callWithProbeAgent("opencode-zen", "ap5-model", ZEN, "k", conv(), AGENT_O, TOOL_CTX, "openai-chat");
    expect(r.result.ok === false && r.result.reason).toBe("http-error");
    expect(r.via).toBe("openai-chat");
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    expect(bodies()[0]).toContain('"tools"');
  });

  it("all styles 400 → http-error + warning naming tried styles", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad request", { status: 400 })),
    );
    const r = await callWithProbeAgent("opencode-zen", "ap6-model", ZEN, "k", conv(), AGENT_O, TOOL_CTX);
    expect(r.result.ok).toBe(false);
    expect(r.result.ok === false && r.result.reason).toBe("http-error");
    expect(r.result.ok === false && r.result.reason === "http-error" && r.result.status).toBe(400);
    expect(r.via).toBe("google-models");
    // Every style was attempted (each tools attempt plus the loop's no-tools
    // retry, which itself may trigger an adapter format fallback — so only
    // the per-style coverage is pinned, not an exact fetch count).
    const called = vi.mocked(fetch).mock.calls.map((c) => String(c[0]));
    expect(called.some((u) => u.endsWith("/chat/completions"))).toBe(true);
    expect(called.some((u) => u.endsWith("/responses"))).toBe(true);
    expect(called.some((u) => u.endsWith("/messages"))).toBe(true);
    expect(called.some((u) => u.includes(":generateContent"))).toBe(true);
    expect(warnings()).toHaveLength(1);
    const w = warnings()[0]!;
    expect(w).toContain("ap6-model");
    for (const s of PROBE_ORDER) expect(w).toContain(s);
  });

  it("probed styles share one probe deadline instead of restarting it", async () => {
    probeBudgets().length = 0;
    // Advance the real clock on every read: a per-style recompute would
    // land later than the first style's deadline, so equality pins sharing.
    let now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => (now += 1000));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        // Turn-0 404 on chat advances the probe; responses then succeeds.
        if (u.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
        return new Response(JSON.stringify(RESPONSES_OK), { status: 200 });
      }),
    );
    const r = await callWithProbeAgent("opencode-zen", "ap-deadline-model", ZEN, "k", conv(), AGENT_O, TOOL_CTX);
    expect(r.result).toEqual({ ok: true, findings: [FINDING] });
    expect(r.via).toBe("openai-responses");
    // Exactly two styles ran (chat advanced, responses succeeded).
    expect(probeBudgets()).toHaveLength(2);
    const first = probeBudgets()[0]!.deadlineMs;
    expect(first).toBeDefined();
    // The second probed style receives the FIRST style's deadline (shared,
    // not restarted): strict equality, no wall-clock arithmetic.
    expect(probeBudgets()[1]!.deadlineMs).toBe(first);
  });
});

describe("callByStyleAgent", () => {
  it("callByStyleAgent runs the loop for an explicit endpoint", async () => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        n += 1;
        if (n === 1) return new Response(JSON.stringify(TOOL_CALL_CHAT), { status: 200 });
        return new Response(JSON.stringify(CHAT_OK), { status: 200 });
      }),
    );
    const ep = buildEndpointForStyle("opencode-zen", "ap7-model", ZEN, "k", "openai-chat", null, false);
    const r = await callByStyleAgent(
      ep,
      conv(),
      { model: "ap7-model", apiKey: "k", maxTokens: 50, timeoutSeconds: 5, provider: "opencode-zen", maxTurns: 5, maxSeconds: 120 },
      TOOL_CTX,
    );
    expect(r).toEqual({ ok: true, findings: [FINDING] });
    // Tool turn executed, then the final turn: the loop ran.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });
});
