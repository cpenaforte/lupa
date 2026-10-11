import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentReply } from "../../src/llm.js";
import type { Conversation, ToolCall } from "../../src/agent-types.js";
import type { ToolContext } from "../../src/agent-tools.js";
import { runAgent } from "../../src/agent.js";
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
