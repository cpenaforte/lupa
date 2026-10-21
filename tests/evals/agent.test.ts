import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentReply } from "../../src/llm.js";
import type { Conversation, ToolCall } from "../../src/agent-types.js";
import type { ToolContext } from "../../src/agent-tools.js";
import { runAgent } from "../../src/agent.js";
import { callMessagesTurn } from "../../src/adapters/messages.js";
import type { AgentBudget, AgentHooks } from "../../src/agent.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function tc(id: string, name: string, args: unknown): ToolCall {
  return { id, name, args, rawArgs: JSON.stringify(args) };
}

function okText(text: string, toolCalls: ToolCall[] = []): AgentReply {
  return { ok: true, text, toolCalls };
}

describe("deterministic agent tool-round evaluation", () => {
  it("retains accepted no-tools capability and shared cancellation during fallback repair", async () => {
    const controller = new AbortController();
    const context = { deadlineMs: Date.now() + 120_000, signal: controller.signal };
    const seenContexts: unknown[] = [];
    let count = 0;
    const outcome = await runAgent({ system: "s", user: "u" }, { roots: { self: "/tmp" } }, {
      maxTurns: 5, maxSeconds: 120, timeoutSeconds: 5, context,
    }, {
      call: async (_conversation, _flags, options) => {
        seenContexts.push(options.context);
        count++;
        if (count === 1) return { ok: false, result: { ok: false, reason: "http-error", status: 400, detail: "bad tools" } };
        if (count === 2) return okText("invalid JSON");
        controller.abort();
        return new Promise<AgentReply>(() => {});
      },
      log: () => {},
    });
    expect(count).toBe(3);
    expect(seenContexts.every((seen) => seen === context)).toBe(true);
    expect(outcome.result).toMatchObject({ ok: false, reason: "timeout" });
    expect(outcome.toolsUnsupported).toBe(true);
    expect(outcome.probeAdvance).toBe(false);
  });

  it.each(["forced-final", "repair"])("native %s keeps signed prefix and definitions through the real loop", async (mode) => {
    const raw = [
      { type: "thinking", thinking: "inspect", signature: "opaque+/=" },
      { type: "redacted_thinking", data: "opaque-data" },
      { type: "tool_use", id: "native-1", name: "bogus", input: {} },
    ];
    const requests: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({
        type: "message", role: "assistant",
        content: requests.length === 1 ? raw : [{ type: "text", text: mode === "repair" && requests.length === 2 ? "invalid JSON" : '{"findings":[]}' }],
        stop_reason: requests.length === 1 ? "tool_use" : "end_turn",
      }), { status: 200 });
    }));
    const outcome = await runAgent({ system: "s", user: "u", tools: [
      { name: "bogus", description: "synthetic tool", parameters: { type: "object" } },
    ] }, { roots: { self: "/tmp" } }, { maxTurns: mode === "forced-final" ? 1 : 5, maxSeconds: 120, timeoutSeconds: 5 }, {
      call: (conversation, flags, options) => callMessagesTurn({
        baseUrl: "https://native.invalid/v1", path: "/messages", headers: {}, apiStyle: "anthropic-messages",
      }, conversation, { model: "synthetic-native", apiKey: "synthetic-key", maxTokens: 50, ...options }, flags),
      log: () => {},
    });
    expect(outcome.result).toEqual({ ok: true, findings: [] });
    expect(outcome.stop).toBe(mode === "forced-final" ? "budget" : "final");
    expect(requests).toHaveLength(mode === "forced-final" ? 2 : 3);
    const final = requests.at(-1)!;
    expect(final.tool_choice).toEqual({ type: "none" });
    expect(JSON.stringify(final.tools)).toBe(JSON.stringify(requests[0]!.tools));
    expect((final.messages as Array<{ content: unknown }>)[1]!.content).toEqual(raw);
  });

  it("reads synthetic changed-line evidence before returning the exact structured finding", async () => {
    const fetchMock = vi.fn(() => { throw new Error("unexpected network request in synthetic agent evaluation"); });
    vi.stubGlobal("fetch", fetchMock);

    const root = mkdtempSync(join(tmpdir(), "lupa-agent-eval-"));
    roots.push(root);
    const fixture = readFileSync(new URL("../fixtures/evals/agent/changed.ts", import.meta.url), "utf8");
    writeFileSync(join(root, "changed.ts"), fixture);

    const replies: AgentReply[] = [
      okText("", [tc("read-1", "read_file", { path: "changed.ts" })]),
      okText('{"findings":[{"severity":"warning","file":"changed.ts","line":3,"rule":"synthetic-check","message":"Synthetic changed line needs validation.","suggestion":null}]}'),
    ];
    const received: Conversation[] = [];
    let replyIndex = 0;
    const conv: Conversation = { system: "synthetic evaluation", user: "Inspect the changed file." };
    const toolCtx: ToolContext = { roots: { self: root } };
    const budget: AgentBudget = { maxTurns: 5, maxSeconds: 120, timeoutSeconds: 60 };
    const hooks: AgentHooks = {
      call: async (conversation) => {
        received.push(structuredClone(conversation));
        return replies[replyIndex++]!;
      },
      log: () => {},
      clock: () => 1_000_000,
    };

    const outcome = await runAgent(conv, toolCtx, budget, hooks);

    expect(received).toHaveLength(2);
    expect(received[0]!.turns).toEqual([]);
    expect(received[1]!.turns).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "assistant", toolCalls: [expect.objectContaining({ name: "read_file" })] }),
      expect.objectContaining({ role: "tool", id: "read-1", name: "read_file", output: expect.stringContaining("SYNTHETIC_CHANGED_LINE") }),
    ]));
    expect(outcome.result).toEqual({
      ok: true,
      findings: [{
        severity: "warning",
        file: "changed.ts",
        line: 3,
        rule: "synthetic-check",
        message: "Synthetic changed line needs validation.",
      }],
    });
    expect(outcome.stop).toBe("final");
    expect(outcome.turns).toBe(2);
    expect(outcome.calls).toBe(1);
    expect(received[1]!.turns?.some((turn) => turn.role === "tool")).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
