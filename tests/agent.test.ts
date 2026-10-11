import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentReply } from "../src/llm.js";
import type { Conversation, ToolCall } from "../src/agent-types.js";
import type { ToolContext } from "../src/agent-tools.js";
import { runAgent } from "../src/agent.js";
import type { AgentBudget, AgentHooks } from "../src/agent.js";

const created: string[] = [];
function tempRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "lupa-agent-loop-"));
  created.push(d);
  return d;
}
afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

function tc(id: string, name: string, args: unknown): ToolCall {
  return { id, name, args, rawArgs: JSON.stringify(args) };
}
function okText(text: string, toolCalls: ToolCall[] = [], rawItems?: unknown[]): AgentReply {
  return rawItems === undefined ? { ok: true, text, toolCalls } : { ok: true, text, toolCalls, rawItems };
}
function fail(status: number): AgentReply {
  return { ok: false, result: { ok: false, reason: "http-error", detail: `HTTP ${status}: nope`, status } };
}
const FINDINGS = '{"findings":[]}';
const BUDGET_NOTE = "Tool budget exhausted. Respond with ONLY the JSON findings object matching the schema.";
const REPAIR_NOTE =
  "Your previous message was not valid JSON. Respond with ONLY the JSON findings object matching the schema; no prose.";

interface Harness {
  budget: AgentBudget;
  hooks: AgentHooks;
  toolCtx: ToolContext;
  conv: Conversation;
  logs: string[];
  seenFlags: Array<{ allowTools: boolean; allowFormat: boolean }>;
  seenOpts: Array<{ timeoutSeconds: number }>;
  advance: (ms: number) => void;
  ncalls: () => number;
}

function harness(root: string, replies: AgentReply[], budgetPatch?: Partial<AgentBudget>): Harness {
  let now = 1_000_000;
  const logs: string[] = [];
  const seenFlags: Array<{ allowTools: boolean; allowFormat: boolean }> = [];
  const seenOpts: Array<{ timeoutSeconds: number }> = [];
  let i = 0;
  const budget: AgentBudget = { maxTurns: 5, maxSeconds: 120, timeoutSeconds: 60, ...(budgetPatch ?? {}) };
  const hooks: AgentHooks = {
    call: async (_conv, flags, callOpts) => {
      seenFlags.push({ ...flags });
      seenOpts.push({ ...callOpts });
      const r = replies[Math.min(i, replies.length - 1)];
      i += 1;
      return r as AgentReply;
    },
    log: (m) => {
      logs.push(m);
    },
    clock: () => now,
  };
  return {
    budget,
    hooks,
    toolCtx: { roots: { self: root } },
    conv: { system: "sys", user: "user" },
    logs,
    seenFlags,
    seenOpts,
    advance: (ms: number) => {
      now += ms;
    },
    ncalls: () => i,
  };
}

describe("runAgent", () => {
  it("runs tool call → result → final JSON with stop=final", async () => {
    const root = tempRoot();
    writeFileSync(join(root, "a.txt"), "hello\n");
    const h = harness(root, [
      okText("", [tc("1", "read_file", { path: "a.txt" })], [{ type: "reasoning" }]),
      okText(FINDINGS),
    ]);
    const out = await runAgent(h.conv, h.toolCtx, h.budget, h.hooks);
    expect(out.result).toEqual({ ok: true, findings: [] });
    expect(out.stop).toBe("final");
    expect(out.probeAdvance).toBe(false);
    expect(out.toolsUnsupported).toBe(false);
    expect(out.turns).toBe(2);
    expect(out.calls).toBe(1);
    expect(h.conv.turns).toHaveLength(3);
    expect(h.conv.turns![0]).toMatchObject({ role: "assistant", rawItems: [{ type: "reasoning" }] });
    expect(h.conv.turns![1]).toMatchObject({ role: "tool", id: "1", name: "read_file" });
    expect(h.conv.turns![2]).toMatchObject({ role: "assistant" });
  });

  it("caps tool calls per turn and returns error results for extras", async () => {
    const root = tempRoot();
    writeFileSync(join(root, "a.txt"), "hello\n");
    const six = Array.from({ length: 6 }, (_, i) => tc(String(i + 1), "read_file", { path: "a.txt" }));
    const h = harness(root, [okText("", six), okText(FINDINGS)]);
    const out = await runAgent(h.conv, h.toolCtx, h.budget, h.hooks);
    expect(out.stop).toBe("final");
    expect(out.calls).toBe(4);
    const toolTurns = h.conv.turns!.filter((t) => t.role === "tool");
    expect(toolTurns).toHaveLength(6);
    for (const t of toolTurns.slice(0, 4)) expect(t).not.toHaveProperty("isError");
    expect(out.result.ok).toBe(true);
    for (const t of toolTurns.slice(4)) {
      expect(t).toMatchObject({
        output: '{"error":"too many tool calls in one turn (max 4)"}',
        isError: true,
      });
    }
  });

  it("forced final on turn budget includes the exact budget note", async () => {
    const root = tempRoot();
    writeFileSync(join(root, "a.txt"), "hello\n");
    const h = harness(root, [okText("", [tc("1", "read_file", { path: "a.txt" })]), okText(FINDINGS)], {
      maxTurns: 1,
    });
    const out = await runAgent(h.conv, h.toolCtx, h.budget, h.hooks);
    expect(out.result).toEqual({ ok: true, findings: [] });
    expect(out.stop).toBe("budget");
    expect(h.seenFlags[1]).toEqual({ allowTools: false, allowFormat: true });
    const notes = h.conv.turns!.filter((t) => t.role === "user");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toEqual({ role: "user", text: BUDGET_NOTE });
  });

  it("forced final on bytes budget stops executing tools", async () => {
    const root = tempRoot();
    writeFileSync(join(root, "a.txt"), "hello\n");
    const h = harness(root, [okText("", [tc("1", "read_file", { path: "a.txt" })]), okText(FINDINGS)], {
      maxTotalBytes: 10,
    });
    const out = await runAgent(h.conv, h.toolCtx, h.budget, h.hooks);
    expect(out.result).toEqual({ ok: true, findings: [] });
    expect(out.stop).toBe("budget");
    expect(out.calls).toBe(1);
    expect(h.seenFlags[1]).toEqual({ allowTools: false, allowFormat: true });
    const notes = h.conv.turns!.filter((t) => t.role === "user");
    expect(notes).toEqual([{ role: "user", text: BUDGET_NOTE }]);
  });

  it("aborts with timeout when under 10s remain; otherwise forced final uses the remaining time", async () => {
    const root = tempRoot();
    writeFileSync(join(root, "a.txt"), "hello\n");
    const h = harness(root, [okText(FINDINGS)], { maxSeconds: 5, timeoutSeconds: 60 });
    const out = await runAgent(h.conv, h.toolCtx, h.budget, h.hooks);
    expect(out.result).toEqual({ ok: false, reason: "timeout", detail: "agent budget exhausted" });
    expect(out.stop).toBe("budget");
    expect(h.ncalls()).toBe(0);

    const h2 = harness(root, [okText(FINDINGS)], { maxTurns: 0, maxSeconds: 60, timeoutSeconds: 120 });
    // Start reads the base time; every later read sees 10s elapsed, so the
    // forced-final call observes 50s remaining out of the 60s budget.
    let reads = 0;
    h2.hooks.clock = () => (++reads <= 1 ? 1_000_000 : 1_010_000);
    const out2 = await runAgent(h2.conv, h2.toolCtx, h2.budget, h2.hooks);
    expect(out2.result).toEqual({ ok: true, findings: [] });
    expect(out2.stop).toBe("budget");
    expect(h2.seenOpts[0]).toEqual({ timeoutSeconds: 50 });
  });

  it("repairs invalid final JSON once, then fails invalid-json", async () => {
    const root = tempRoot();
    const h = harness(root, [okText("not json"), okText("still bad")]);
    const out = await runAgent(h.conv, h.toolCtx, h.budget, h.hooks);
    expect(out.result).toEqual({ ok: false, reason: "invalid-json", detail: "model content is not valid JSON" });
    expect(out.stop).toBe("error");
    expect(h.ncalls()).toBe(2);
    expect(h.seenFlags[1]).toEqual({ allowTools: false, allowFormat: true });
    const notes = h.conv.turns!.filter((t) => t.role === "user");
    expect(notes).toEqual([{ role: "user", text: REPAIR_NOTE }]);
  });

  it("turn-0 400 retries without tools: ok → fallback + toolsUnsupported", async () => {
    const root = tempRoot();
    const h = harness(root, [fail(400), okText(FINDINGS)]);
    const out = await runAgent(h.conv, h.toolCtx, h.budget, h.hooks);
    expect(out.result).toEqual({ ok: true, findings: [] });
    expect(out.stop).toBe("fallback");
    expect(out.toolsUnsupported).toBe(true);
    expect(out.probeAdvance).toBe(false);
    expect(h.seenFlags[0]).toEqual({ allowTools: true, allowFormat: false });
    expect(h.seenFlags[1]).toEqual({ allowTools: false, allowFormat: true });
  });

  it("turn-0 400 then 400 again → probeAdvance true; turn-0 500 → false", async () => {
    const root = tempRoot();
    const h = harness(root, [fail(400), fail(400)]);
    const out = await runAgent(h.conv, h.toolCtx, h.budget, h.hooks);
    expect(out.result.ok).toBe(false);
    expect(out.probeAdvance).toBe(true);

    const h2 = harness(root, [fail(500)]);
    const out2 = await runAgent(h2.conv, h2.toolCtx, h2.budget, h2.hooks);
    expect(out2.result.ok).toBe(false);
    expect(out2.probeAdvance).toBe(false);
  });

  it("mid-loop 400 → probeAdvance false", async () => {
    const root = tempRoot();
    writeFileSync(join(root, "a.txt"), "hello\n");
    const h = harness(root, [okText("", [tc("1", "read_file", { path: "a.txt" })]), fail(400)]);
    const out = await runAgent(h.conv, h.toolCtx, h.budget, h.hooks);
    expect(out.result.ok).toBe(false);
    expect(out.probeAdvance).toBe(false);
    expect(out.stop).toBe("error");
  });

  it("malformed tool args return isError and the loop continues", async () => {
    const root = tempRoot();
    const bad: ToolCall = { id: "1", name: "read_file", args: undefined, rawArgs: "{bad" };
    const h = harness(root, [okText("", [bad]), okText(FINDINGS)]);
    const out = await runAgent(h.conv, h.toolCtx, h.budget, h.hooks);
    expect(out.result).toEqual({ ok: true, findings: [] });
    expect(out.stop).toBe("final");
    const toolTurns = h.conv.turns!.filter((t) => t.role === "tool");
    expect(toolTurns).toHaveLength(1);
    expect(toolTurns[0]).toMatchObject({ isError: true });
    expect(JSON.parse((toolTurns[0] as { output: string }).output)).toHaveProperty("error");
  });

  it("unknown tool name returns isError and the loop continues", async () => {
    const root = tempRoot();
    const h = harness(root, [okText("", [tc("1", "bogus", {})]), okText(FINDINGS)]);
    const out = await runAgent(h.conv, h.toolCtx, h.budget, h.hooks);
    expect(out.result).toEqual({ ok: true, findings: [] });
    expect(out.stop).toBe("final");
    const toolTurns = h.conv.turns!.filter((t) => t.role === "tool");
    expect(toolTurns).toEqual([{ role: "tool", id: "1", name: "bogus", output: '{"error":"unknown tool: bogus"}', isError: true }]);
  });

  it("a failing ensureLinked alias yields an error result and the loop still finishes (stop=final)", async () => {
    const root = tempRoot();
    const h = harness(root, [okText("", [tc("1", "read_file", { path: "b.txt", repo: "o/missing" })]), okText(FINDINGS)]);
    h.toolCtx = { roots: { self: root }, ensureLinked: async () => ({ error: "clone failed" }) };
    const out = await runAgent(h.conv, h.toolCtx, h.budget, h.hooks);
    expect(out.result).toEqual({ ok: true, findings: [] });
    expect(out.stop).toBe("final");
    const toolTurns = h.conv.turns!.filter((t) => t.role === "tool");
    expect(toolTurns).toEqual([
      { role: "tool", id: "1", name: "read_file", output: '{"error":"repository not accessible: o/missing"}', isError: true },
    ]);
  });

  it("turn-0 404 returns stop=error with probeAdvance=true", async () => {
    const root = tempRoot();
    const h = harness(root, [fail(404)]);
    const out = await runAgent(h.conv, h.toolCtx, h.budget, h.hooks);
    expect(out.result.ok).toBe(false);
    expect(out.stop).toBe("error");
    expect(out.probeAdvance).toBe(true);
    expect(out.toolsUnsupported).toBe(false);
    expect(h.ncalls()).toBe(1);
  });

  it("truncates an over-cap multibyte tool result with no U+FFFD or lone surrogates", async () => {
    const root = tempRoot();
    writeFileSync(join(root, "emoji.txt"), "😀".repeat(50) + "\n");
    const h = harness(root, [okText("", [tc("1", "read_file", { path: "emoji.txt" })]), okText(FINDINGS)], {
      // Byte 96 of the read_file JSON is the first emoji (4-byte
      // sequence), so a 102-byte cap cuts mid-sequence under a raw byte cut.
      maxResultBytes: 102,
    });
    const out = await runAgent(h.conv, h.toolCtx, h.budget, h.hooks);
    expect(out.result).toEqual({ ok: true, findings: [] });
    expect(out.stop).toBe("final");
    const toolTurn = h.conv.turns!.find((t) => t.role === "tool") as { output: string };
    expect(toolTurn.output.endsWith("[truncated]")).toBe(true);
    expect(toolTurn.output).not.toContain("�");
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(toolTurn.output)).toBe(false);
    const prefix = toolTurn.output.slice(0, toolTurn.output.length - "[truncated]".length);
    expect(Buffer.byteLength(prefix, "utf8")).toBeLessThanOrEqual(102);
  });

  it("logs the exact turn and done lines", async () => {
    const root = tempRoot();
    writeFileSync(join(root, "a.txt"), "hello\n");
    const h = harness(root, [okText("", [tc("1", "read_file", { path: "a.txt" })]), okText(FINDINGS)]);
    const out = await runAgent(h.conv, h.toolCtx, h.budget, h.hooks);
    expect(out.stop).toBe("final");
    const toolTurn = h.conv.turns!.find((t) => t.role === "tool") as { output: string };
    const b = Buffer.byteLength(toolTurn.output, "utf8");
    expect(h.logs).toEqual([
      `agent turn 0: tools=[read_file] results_bytes=${b} ms=0`,
      `agent turn 1: tools=[] results_bytes=0 ms=0`,
      `agent done: turns=2 calls=1 bytes=${b} stop=final elapsed=0s`,
    ]);
  });
});
