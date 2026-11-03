import { getEventListeners } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequestContext } from "../src/runtime/context.js";
import { attempt, sleep, waitForRetry } from "../src/llm/transport.js";
import { callByStyleAgent, callWithProbeAgent, callByStyle, resetProbeMemo, resetToolsMemo } from "../src/llm/router.js";
import { buildEndpointForStyle, type ResolvedApiStyle } from "../src/providers.js";

const options = { model: "test", apiKey: "key", provider: "openai", maxTokens: 50, timeoutSeconds: 60, maxTurns: 5, maxSeconds: 30 };
const ep = (style: ResolvedApiStyle = "openai-chat") => buildEndpointForStyle("openai", "test", "https://example.test/v1", "key", style, null);
const toolCtx = { roots: { self: "/tmp" } };
const ok = JSON.stringify({ choices: [{ message: { content: '{"findings":[]}' } }] });
vi.mock("@actions/core", () => ({ info: vi.fn(), warning: vi.fn() }));
beforeEach(() => { vi.useFakeTimers(); resetProbeMemo(); resetToolsMemo(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("owned request lifetime", () => {
  it("keeps caller ownership and releases every invocation listener after success", async () => {
    const owned = createRequestContext(30_000);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(ok)));
    const result = await callByStyleAgent(ep(), { system: "s", user: "u" }, { ...options, context: owned.context }, toolCtx);
    expect(result.ok).toBe(true);
    expect(owned.context.signal.aborted).toBe(false);
    expect(getEventListeners(owned.context.signal, "abort")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(1);
    owned.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["explicit", "probe"] as const)("disposes its own context after %s success", async (mode) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(ok)));
    const result = mode === "explicit"
      ? await callByStyleAgent(ep(), { system: "s", user: "u" }, options, toolCtx)
      : (await callWithProbeAgent("openai", "test", "https://example.test/v1", "key", { system: "s", user: "u" }, options, toolCtx, "openai-chat")).result;
    expect(result.ok).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a retry delay immediately and removes its timer and listener", async () => {
    const controller = new AbortController();
    const context = { signal: controller.signal, deadlineMs: Date.now() + 30_000 };
    const pending = waitForRetry(5000, context);
    controller.abort();
    expect(await pending).toBe(false);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the agent deadline on a memoized tools-unsupported single-shot fallback", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("unsupported tools", { status: 400 }))
      .mockResolvedValueOnce(new Response(ok))
      .mockImplementationOnce(async (_url, init: RequestInit) => {
        await sleep(28_000, init.signal!);
        return new Response("busy", { status: 429, headers: { "retry-after": "5" } });
      });
    vi.stubGlobal("fetch", fetchMock);
    const call = () => callWithProbeAgent("openai", "test", "https://example.test/v1", "key", { system: "s", user: "u" }, options, toolCtx);
    expect((await call()).result.ok).toBe(true);
    const pending = call();
    await vi.advanceTimersByTimeAsync(35_000);
    expect((await pending).result).toMatchObject({ ok: false, reason: "timeout" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts at the deadline and disposal clears its timer without aborting the caller", async () => {
    const owned = createRequestContext(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(owned.context.signal.aborted).toBe(true);
    owned.dispose();
    const other = createRequestContext(30_000);
    other.dispose();
    expect(other.context.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a retry reaching the deadline and cancels pending sleep", async () => {
    const owned = createRequestContext(1000);
    expect(await waitForRetry(1000, owned.context)).toBe(false);
    const waiting = waitForRetry(900, owned.context);
    await vi.advanceTimersByTimeAsync(900);
    expect(await waiting).toBe(true);
    const controller = new AbortController();
    const sleeping = sleep(5000, controller.signal);
    controller.abort();
    await sleeping;
    owned.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["openai-chat", "openai-responses", "anthropic-messages", "google-models"] as const)("%s never retries a 429 received at 28 seconds beyond a 30 second agent budget", async (style) => {
    const owned = createRequestContext(30_000);
    const fetchMock = vi.fn(async (_url, init: RequestInit) => { await sleep(28_000, init.signal!); return new Response("busy", { status: 429, headers: { "retry-after": "5" } }); });
    vi.stubGlobal("fetch", fetchMock);
    const pending = callByStyleAgent(ep(style), { system: "s", user: "u" }, { ...options, context: owned.context }, toolCtx);
    await vi.advanceTimersByTimeAsync(35_000);
    const result = await pending;
    owned.dispose();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: false, reason: "timeout" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps cancellation active while consuming the response body", async () => {
    const owned = createRequestContext(1000);
    let observed: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url, init: RequestInit) => {
      observed = init.signal!;
      return { text: () => new Promise((_resolve, reject) => observed!.addEventListener("abort", () => reject(new Error("aborted")), { once: true })) };
    }));
    const pending = attempt(ep(), "{}", { ...options, context: owned.context });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({ kind: "fail", result: { reason: "timeout" } });
    expect(observed!.aborted).toBe(true);
    owned.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shares the original deadline across probe styles", async () => {
    const owned = createRequestContext(30_000);
    const signals: AbortSignal[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init: RequestInit) => {
      signals.push(init.signal!);
      if (signals.length === 1) { await sleep(15_000); return new Response("missing", { status: 404 }); }
      return { text: () => new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true })) };
    }));
    const pending = callWithProbeAgent("openai", "test", "https://example.test/v1", "key", { system: "s", user: "u" }, { ...options, context: owned.context }, toolCtx);
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await pending).result).toMatchObject({ ok: false, reason: "timeout" });
    expect(signals).toHaveLength(2);
    expect(signals[1].aborted).toBe(true);
    owned.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["openai-responses", "google-models"] as const)("%s does not start schema fallback after cancellation", async (style) => {
    const controller = new AbortController();
    const context = { signal: controller.signal, deadlineMs: Date.now() + 30_000 };
    const fetchMock = vi.fn(async () => { controller.abort(); return new Response("unsupported schema", { status: 400 }); });
    vi.stubGlobal("fetch", fetchMock);
    expect(await callByStyle(ep(style), { system: "s", user: "u" }, { ...options, context })).toMatchObject({ ok: false, reason: "timeout" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves a no-context single-shot retry with a fresh per-attempt budget", async () => {
    const fetchMock = vi.fn().mockImplementationOnce(async () => { await sleep(28_000); return new Response("busy", { status: 429, headers: { "retry-after": "5" } }); }).mockResolvedValueOnce(new Response(ok));
    vi.stubGlobal("fetch", fetchMock);
    const pending = callByStyle(ep(), { system: "s", user: "u" }, { ...options, timeoutSeconds: 30 });
    await vi.advanceTimersByTimeAsync(35_000);
    expect(await pending).toMatchObject({ ok: true, findings: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
