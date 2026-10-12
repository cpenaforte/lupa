import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as core from "@actions/core";
import { callWithProbe, resetProbeMemo, PROBE_ORDER } from "../src/llm.js";

vi.mock("@actions/core", () => ({ warning: vi.fn(), info: vi.fn() }));

// ---------- helpers ----------

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

/** Findings JSON carrying dedup verdicts: one pair plus a model-finding pointer. */
const FINDINGS_JSON_V = JSON.stringify({
  findings: [{ ...FINDING, duplicateOf: 0 }],
  duplicates: [[0, 1]],
});
const RESPONSES_OK_V = {
  status: "completed",
  output: [{ type: "message", content: [{ type: "output_text", text: FINDINGS_JSON_V }] }],
};
const msgs = { system: "s", user: "u" };
const o = { maxTokens: 50, timeoutSeconds: 5 };
const ZEN = "https://opencode.ai/zen/v1";

/** URL-aware fetch stub: `misses` leading 404s, then `okBody` with 200. */
function stubProbe(misses: number, okBody: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const n = vi.mocked(fetch).mock.calls.length;
      return n <= misses
        ? new Response(JSON.stringify({ error: { message: "not found" } }), { status: 404 })
        : new Response(JSON.stringify(okBody), { status: 200 });
    }),
  );
}

function urls(): string[] {
  return vi.mocked(fetch).mock.calls.map((c) => String(c[0]));
}

function warnings(): string[] {
  return vi.mocked(core.warning).mock.calls.map((c) => String(c[0]));
}

beforeEach(() => {
  // Test-only: the in-process memo must not leak across tests.
  resetProbeMemo();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------- spec §9.5: error-driven routing ----------

describe("callWithProbe: auto discovers the style from 400/404 errors", () => {
  it("auto probes chat→responses and succeeds on second style", async () => {
    stubProbe(1, RESPONSES_OK);
    const r = await callWithProbe("opencode-zen", "alpha-model", ZEN, "k", msgs, o);
    expect(r.result).toEqual({
      ok: true,
      findings: [FINDING],
      verdicts: { pairs: [], links: [], malformed: 0 },
    });
    expect(r.via).toBe("openai-responses");
    expect(urls()).toEqual([`${ZEN}/chat/completions`, `${ZEN}/responses`]);
  });

  it("probe surfaces ONLY the winning style's verdicts (400 loser leaks nothing)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.endsWith("/chat/completions")) {
          // Loser: HTTP 400 with a verdicts-shaped body that must never be
          // parsed (a 400 never reaches parseContent — no verdicts can attach).
          return new Response(
            JSON.stringify({ findings: [], duplicates: [[7, 8]], error: { message: "bad request" } }),
            { status: 400 },
          );
        }
        return new Response(JSON.stringify(RESPONSES_OK_V), { status: 200 });
      }),
    );
    const r = await callWithProbe("opencode-zen", "alpha-verdicts", ZEN, "k", msgs, o);
    // toFindings ignores the new keys, so findings stay exactly [FINDING];
    // verdicts equal ONLY the winner's — the loser's [[7, 8]] is absent.
    expect(r.result).toEqual({
      ok: true,
      findings: [FINDING],
      verdicts: { pairs: [[0, 1]], links: [[0, 0]], malformed: 0 },
    });
    expect(r.via).toBe("openai-responses");
    expect(urls()).toEqual([`${ZEN}/chat/completions`, `${ZEN}/responses`]);
  });

  // Spec §9.5 test list: 404→success sequence for every winning style.
  it.each([
    ["openai-chat", 0, "/chat/completions", CHAT_OK],
    ["openai-responses", 1, "/responses", RESPONSES_OK],
    ["anthropic-messages", 2, "/messages", MESSAGES_OK],
    ["google-models", 3, ":generateContent", GOOGLE_OK],
  ] as const)("auto %s: walks %i style miss(es) and succeeds", async (style, misses, pathSuffix, okBody) => {
    stubProbe(misses, okBody);
    const model = `probe-${style}`;
    const r = await callWithProbe("opencode-zen", model, ZEN, "k", msgs, o);
    expect(r.result).toEqual({ ok: true, findings: [FINDING], verdicts: { pairs: [], links: [], malformed: 0 } });
    expect(r.via).toBe(style);
    const called = urls();
    expect(called).toHaveLength(misses + 1);
    expect(called.at(-1)).toContain(pathSuffix);
  });

  it("auto walks all four styles and fails with http-error + warning", async () => {
    stubProbe(4, {});
    const r = await callWithProbe("opencode-zen", "epsilon-model", ZEN, "k", msgs, o);
    expect(r.result.ok).toBe(false);
    expect(r.result.ok === false && r.result.reason).toBe("http-error");
    expect(r.result.ok === false && r.result.detail).toContain("HTTP 404");
    // The last failure's numeric status rides the exhaustion result (R1 contract).
    expect(r.result.ok === false && r.result.reason === "http-error" && r.result.status).toBe(404);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(PROBE_ORDER.length);
    expect(warnings()).toHaveLength(1);
    const w = warnings()[0];
    expect(w).toContain("epsilon-model");
    for (const s of PROBE_ORDER) expect(w).toContain(s);
  });

  it("a persistent 400 (schema-fallback exhausted) advances the probe — spec §9.5", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
        if (u.endsWith("/responses")) {
          return new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400 });
        }
        if (u.endsWith("/messages")) return new Response(JSON.stringify(MESSAGES_OK), { status: 200 });
        return new Response("not found", { status: 404 });
      }),
    );
    const r = await callWithProbe("opencode-zen", "nu-model", ZEN, "k", msgs, o);
    expect(r.result).toEqual({ ok: true, findings: [FINDING], verdicts: { pairs: [], links: [], malformed: 0 } });
    expect(r.via).toBe("anthropic-messages");
    // chat 404 (1 fetch) + responses 400 with and without the strict format (2) + messages (1).
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(4);
  });

  it("a non-400/404 failure stops the probe at the first style", async () => {
    // A refusal is not a style signal: no probe advance, no probe warning.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "", refusal: "no" } }] }), { status: 200 })),
    );
    const r = await callWithProbe("opencode-zen", "zeta-refusal", ZEN, "k", msgs, o);
    expect(r.result).toEqual({ ok: false, reason: "content-filter", detail: "model refused the request" });
    expect(r.via).toBe("openai-chat");
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    expect(warnings()).toHaveLength(0);
  });

  it("429/5xx does not advance the probe (adapter retry only)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("rate limited", { status: 429, headers: { "retry-after": "0" } })),
    );
    const r = await callWithProbe("opencode-zen", "eta-model", ZEN, "k", msgs, o);
    expect(r.result.ok).toBe(false);
    expect(r.result.ok === false && r.result.detail).toContain("HTTP 429");
    expect(r.via).toBe("openai-chat");
    // One adapter retry on the SAME style: two fetches, both to chat.
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    for (const u of urls()) expect(u).toBe(`${ZEN}/chat/completions`);
    expect(warnings()).toHaveLength(0);
  });

  it("memo fixes style for subsequent calls in-process", async () => {
    stubProbe(1, RESPONSES_OK);
    const first = await callWithProbe("opencode-zen", "theta-model", ZEN, "k", msgs, o);
    expect(first.via).toBe("openai-responses");
    expect(urls()).toHaveLength(2);
    const second = await callWithProbe("opencode-zen", "theta-model", ZEN, "k", msgs, o);
    expect(second.result).toEqual({ ok: true, findings: [FINDING], verdicts: { pairs: [], links: [], malformed: 0 } });
    expect(second.via).toBe("openai-responses");
    // The memoized style is tried directly: one more fetch, straight to /responses.
    expect(urls()).toHaveLength(3);
    expect(urls().at(-1)).toBe(`${ZEN}/responses`);
  });

  it("a stale memo does not dead-end the probe: it is dropped and the walk continues", async () => {
    let drifted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.endsWith("/responses")) {
          return drifted
            ? new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400 })
            : new Response(JSON.stringify(RESPONSES_OK), { status: 200 });
        }
        if (u.endsWith("/chat/completions")) {
          return drifted
            ? new Response(JSON.stringify(CHAT_OK), { status: 200 })
            : new Response("not found", { status: 404 });
        }
        return new Response("not found", { status: 404 });
      }),
    );
    // Seed the memo: chat 404s, responses wins.
    const first = await callWithProbe("opencode-zen", "stale-memo-model", ZEN, "k", msgs, o);
    expect(first.via).toBe("openai-responses");
    // The contract drifts: the memoized style now answers a persistent 400.
    drifted = true;
    const second = await callWithProbe("opencode-zen", "stale-memo-model", ZEN, "k", msgs, o);
    expect(second.result).toEqual({ ok: true, findings: [FINDING], verdicts: { pairs: [], links: [], malformed: 0 } });
    expect(second.via).toBe("openai-chat");
    // The memo now points at the new winner: one fetch, straight to chat.
    const before = vi.mocked(fetch).mock.calls.length;
    const third = await callWithProbe("opencode-zen", "stale-memo-model", ZEN, "k", msgs, o);
    expect(third.via).toBe("openai-chat");
    expect(vi.mocked(fetch).mock.calls.length).toBe(before + 1);
    expect(urls().at(-1)).toBe(`${ZEN}/chat/completions`);
  });

  it("a stale memo whose style exhausts warns with every style tried", async () => {
    let seeded = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (!seeded && u.endsWith("/responses")) return new Response(JSON.stringify(RESPONSES_OK), { status: 200 });
        return new Response("not found", { status: 404 });
      }),
    );
    // Seed the memo with a responses success (chat 404s first).
    const first = await callWithProbe("opencode-zen", "stale-exhaust-model", ZEN, "k", msgs, o);
    expect(first.via).toBe("openai-responses");
    const seededCalls = vi.mocked(fetch).mock.calls.length;
    // Everything answers 404 now: the memoized style first, then the rest of the order.
    seeded = true;
    const r = await callWithProbe("opencode-zen", "stale-exhaust-model", ZEN, "k", msgs, o);
    expect(r.result.ok === false && r.result.reason).toBe("http-error");
    expect(r.result.ok === false && r.result.reason === "http-error" && r.result.status).toBe(404);
    expect(vi.mocked(fetch).mock.calls.length).toBe(seededCalls + PROBE_ORDER.length);
    expect(warnings()).toHaveLength(1);
    const w = warnings()[0];
    expect(w).toContain("stale-exhaust-model");
    for (const s of PROBE_ORDER) expect(w).toContain(s);
  });

  it("redaction holds across every probe attempt", async () => {
    const key = "sk-SECRET-KEY-123";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { message: `no route for ${key}` } }), { status: 404 })),
    );
    const r = await callWithProbe("opencode-zen", "iota-model", ZEN, key, msgs, o);
    expect(r.result.ok === false && r.result.reason).toBe("http-error");
    const detail = r.result.ok === false ? r.result.detail : "";
    expect(detail).toContain("[REDACTED]");
    expect(detail).not.toContain(key);
    for (const w of warnings()) expect(w).not.toContain(key);
  });

  it("custom-path never reaches a probe: rejected with a clear error", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(
      // Bypass the Exclude<..., "custom-path"> type on purpose: the runtime guard stays loud.
      callWithProbe("custom", "xi-model", "https://x", "k", msgs, o, "custom-path" as never),
    ).rejects.toThrow(/requires llm_path/);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("explicit style never probes (single fetch even on 404)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { message: "not found" } }), { status: 404 })),
    );
    const r = await callWithProbe("opencode-zen", "kappa-model", ZEN, "k", msgs, o, "openai-responses");
    expect(r.result.ok === false && r.result.reason).toBe("http-error");
    expect(r.result.ok === false && r.result.detail).toContain("HTTP 404");
    expect(r.via).toBe("openai-responses");
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    expect(urls()).toEqual([`${ZEN}/responses`]);
  });

  it("no key: no-key without a fetch", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const r = await callWithProbe("opencode-zen", "lambda-model", ZEN, "", msgs, o);
    expect(r.result).toEqual({ ok: false, reason: "no-key", detail: "no API key configured" });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("probe keeps the go session header on every style", async () => {
    stubProbe(0, MESSAGES_OK);
    await callWithProbe("opencode-go", "mu-model", "https://opencode.ai/zen/go/v1", "k", msgs, { ...o, prNumber: 7 });
    const headers = (vi.mocked(fetch).mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers["x-opencode-session"]).toBe("pr-7");
  });

  // R3-warning fix regression pin: the probe's preset-derived base must not
  // read as user-supplied when google-models strips the /openai suffix.
  it("probe on the google preset never misfires the /openai rewrite warning", async () => {
    stubProbe(3, GOOGLE_OK);
    const r = await callWithProbe(
      "google",
      "probe-google-misfire",
      "https://generativelanguage.googleapis.com/v1beta/openai",
      "k",
      msgs,
      o,
    );
    expect(r.result).toEqual({ ok: true, findings: [FINDING], verdicts: { pairs: [], links: [], malformed: 0 } });
    expect(r.via).toBe("google-models");
    expect(urls().at(-1)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/probe-google-misfire:generateContent",
    );
    expect(warnings()).toHaveLength(0);
  });
});
