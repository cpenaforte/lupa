import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentReply } from "../src/llm.js";
import type { LlmUsage } from "../src/llm.js";
import type { Conversation, ToolCall } from "../src/agent-types.js";
import type { ToolContext } from "../src/agent-tools.js";
import { capToolResult, runAgent } from "../src/agent.js";
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
function okUsage(text: string, toolCalls: ToolCall[], usage: LlmUsage): AgentReply {
  return { ok: true, text, toolCalls, usage };
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
  seenOpts: Array<{ timeoutSeconds: number; deadlineMs: number }>;
  advance: (ms: number) => void;
  ncalls: () => number;
}

function harness(root: string, replies: AgentReply[], budgetPatch?: Partial<AgentBudget>): Harness {
  let now = 1_000_000;
  const logs: string[] = [];
  const seenFlags: Array<{ allowTools: boolean; allowFormat: boolean }> = [];
  const seenOpts: Array<{ timeoutSeconds: number; deadlineMs: number }> = [];
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
    const h = harness(root, [okText(FINDINGS)], {
      maxTotalBytes: 10,
    });
    const out = await runAgent(h.conv, h.toolCtx, h.budget, h.hooks);
    expect(out.result).toEqual({ ok: true, findings: [] });
    expect(out.stop).toBe("budget");
    expect(out.calls).toBe(0);
    expect(h.seenFlags[0]).toEqual({ allowTools: false, allowFormat: true });
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
    expect(h2.seenOpts[0]).toEqual({ timeoutSeconds: 50, deadlineMs: 1_060_000 });
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

  it("turn-0 tools-fallback retry counts its consumed usage", async () => {
    const root = tempRoot();
    const h = harness(root, [fail(400), okUsage(FINDINGS, [], { input: 3, output: 2, calls: 1 })]);
    const out = await runAgent(h.conv, h.toolCtx, h.budget, h.hooks);
    expect(out.stop).toBe("fallback");
    expect(out.usage).toEqual({ input: 3, output: 2, calls: 1 });
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

  describe("capToolResult", () => {
    const ENVELOPE = '{"error":"tool result exceeded the byte budget","truncated":true}';
    it("passes small valid JSON through unchanged", () => {
      expect(capToolResult('{"a":1}', 100)).toBe('{"a":1}');
    });
    it("replaces over-cap JSON with the exact 65-byte envelope", () => {
      expect(Buffer.byteLength(ENVELOPE, "utf8")).toBe(65);
      const big = JSON.stringify({ content: "x".repeat(200) });
      expect(capToolResult(big, 50)).toBe(ENVELOPE);
    });
    it("replaces invalid JSON with the exact envelope", () => {
      expect(capToolResult("not json", 1000)).toBe(ENVELOPE);
    });
    it("replaces over-cap multibyte output with the envelope and no U+FFFD", () => {
      const out = capToolResult("😀".repeat(50), 10);
      expect(out).toBe(ENVELOPE);
      expect(out).not.toContain("�");
    });
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

  it("pre-expired deadlineMs stops before the first turn without calling", async () => {
    const root = tempRoot();
    const h = harness(root, [okText(FINDINGS)], { deadlineMs: 999_999 });
    const out = await runAgent(h.conv, h.toolCtx, h.budget, h.hooks);
    expect(out.result).toEqual({ ok: false, reason: "timeout", detail: "agent budget exhausted" });
    expect(out.stop).toBe("budget");
    expect(out.probeAdvance).toBe(false);
    expect(h.ncalls()).toBe(0);
  });

  it("an already-passed deadline skips hooks.call instead of racing it", async () => {
    const root = tempRoot();
    const h = harness(root, [okText(FINDINGS)], { maxSeconds: 30, deadlineMs: 1_030_000 });
    // start, loop-top check (30s remain, no timeout), remaining read (past
    // the deadline), then sticks on the last value.
    const scripted = [1_000_000, 1_000_000, 1_031_000];
    h.hooks.clock = () => (scripted.length > 1 ? scripted.shift()! : scripted[0]!);
    const out = await runAgent(h.conv, h.toolCtx, h.budget, h.hooks);
    expect(out.result).toEqual({ ok: false, reason: "timeout", detail: "agent budget exhausted" });
    expect(out.stop).toBe("budget");
    expect(out.probeAdvance).toBe(false);
    expect(h.ncalls()).toBe(0);
  });

  it("real-timer fallback: a call in flight when the deadline passes loses the race with stop=budget", async () => {
    vi.useFakeTimers();
    try {
      const root = tempRoot();
      const h = harness(root, [okText(FINDINGS)], { maxSeconds: 30 });
      h.hooks.call = () => new Promise<AgentReply>(() => {});
      const p = runAgent(h.conv, h.toolCtx, h.budget, h.hooks);
      await vi.advanceTimersByTimeAsync(30_000);
      const out = await p;
      expect(out.result).toEqual({ ok: false, reason: "timeout", detail: "agent budget exhausted" });
      expect(out.stop).toBe("budget");
      expect(out.probeAdvance).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a far-future deadline leaves normal handling untouched", async () => {
    const root = tempRoot();
    const h = harness(root, [okText(FINDINGS)], { maxSeconds: 3600 });
    const out = await runAgent(h.conv, h.toolCtx, h.budget, h.hooks);
    expect(out.result).toEqual({ ok: true, findings: [] });
    expect(out.stop).toBe("final");
    expect(h.seenOpts[0]).toEqual({ timeoutSeconds: 60, deadlineMs: 4_600_000 });
  });

  it("floors (not ceils) the per-call timeout with 10.5s remaining", async () => {
    const root = tempRoot();
    const h = harness(root, [okText(FINDINGS)], { maxSeconds: 60, timeoutSeconds: 120 });
    // Start reads the base time; every later read sees 49.5s elapsed, so the
    // call observes 10.5s remaining out of the 60s budget.
    let reads = 0;
    h.hooks.clock = () => (++reads <= 1 ? 1_000_000 : 1_049_500);
    const out = await runAgent(h.conv, h.toolCtx, h.budget, h.hooks);
    expect(out.result).toEqual({ ok: true, findings: [] });
    expect(out.stop).toBe("final");
    expect(h.seenOpts[0]).toEqual({ timeoutSeconds: 10, deadlineMs: 1_060_000 });
  });

  it("a same-turn tool budget exhaustion records the exact error without incrementing calls", async () => {
    const root = tempRoot();
    writeFileSync(join(root, "a.txt"), "hello\n");
    const h = harness(
      root,
      [
        okText("", [tc("1", "read_file", { path: "a.txt" }), tc("2", "read_file", { path: "a.txt" })]),
        okText(FINDINGS),
      ],
      { maxTotalBytes: 110 },
    );
    const out = await runAgent(h.conv, h.toolCtx, h.budget, h.hooks);
    expect(out.calls).toBe(1);
    expect(out.bytes).toBe(99);
    expect(out.stop).toBe("budget");
    const toolTurns = h.conv.turns!.filter((t) => t.role === "tool");
    expect(toolTurns).toHaveLength(2);
    expect(Buffer.byteLength((toolTurns[0] as { output: string }).output, "utf8")).toBe(99);
    expect(toolTurns[1]).toEqual({
      role: "tool",
      id: "2",
      name: "read_file",
      output: '{"error":"tool result budget exhausted (max 110 bytes)"}',
      isError: true,
    });
    const notes = h.conv.turns!.filter((t) => t.role === "user");
    expect(notes).toEqual([{ role: "user", text: BUDGET_NOTE }]);
  });

  it("an over-effective-cap tool result is replaced by the backstop envelope", async () => {
    const root = tempRoot();
    writeFileSync(join(root, "a.txt"), "hello\n");
    const h = harness(root, [okText("", [tc("1", "read_file", { path: "a.txt" })]), okText(FINDINGS)], {
      maxTotalBytes: 50,
    });
    const out = await runAgent(h.conv, h.toolCtx, h.budget, h.hooks);
    expect(out.result).toEqual({ ok: true, findings: [] });
    expect(out.stop).toBe("final");
    expect(out.bytes).toBe(0);
    expect(out.calls).toBe(1);
    const toolTurns = h.conv.turns!.filter((t) => t.role === "tool");
    expect(toolTurns).toEqual([
      {
        role: "tool",
        id: "1",
        name: "read_file",
        output: '{"error":"tool result exceeded the byte budget","truncated":true}',
        isError: true,
      },
    ]);
  });

  it("a sub-marker residue forces the next round instead of executing tools", async () => {
    const root = tempRoot();
    writeFileSync(join(root, "a.txt"), "hello\n");
    const h = harness(root, [okText("", [tc("1", "read_file", { path: "a.txt" })]), okText(FINDINGS)], {
      maxTotalBytes: 110,
    });
    const out = await runAgent(h.conv, h.toolCtx, h.budget, h.hooks);
    expect(out.result).toEqual({ ok: true, findings: [] });
    expect(out.stop).toBe("budget");
    expect(out.bytes).toBe(99);
    expect(out.calls).toBe(1);
    expect(h.seenFlags[1]).toEqual({ allowTools: false, allowFormat: true });
    const notes = h.conv.turns!.filter((t) => t.role === "user");
    expect(notes).toEqual([{ role: "user", text: BUDGET_NOTE }]);
  });

  it("mid-conversation expiry stops the loop after the current turn", async () => {
    const root = tempRoot();
    writeFileSync(join(root, "a.txt"), "hello\n");
    const h = harness(root, [okText("", [tc("1", "read_file", { path: "a.txt" })]), okText(FINDINGS)], {
      maxSeconds: 30,
    });
    const inner = h.hooks.call;
    let n = 0;
    h.hooks.call = async (conv, flags, callOpts) => {
      if (n++ === 0) h.advance(40_000);
      return inner(conv, flags, callOpts);
    };
    const out = await runAgent(h.conv, h.toolCtx, h.budget, h.hooks);
    expect(out.result).toEqual({ ok: false, reason: "timeout", detail: "agent budget exhausted" });
    expect(out.stop).toBe("budget");
    expect(out.probeAdvance).toBe(false);
    expect(h.ncalls()).toBe(1);
  });

  it("sums usage across turns, skipping absent turns (exact total incl. calls)", async () => {
    const root = tempRoot();
    writeFileSync(join(root, "a.txt"), "hello\n");
    const read = (id: string) => [tc(id, "read_file", { path: "a.txt" })];
    const h = harness(root, [
      okUsage("", read("1"), { input: 1, output: 1, calls: 1 }),
      okUsage("", read("2"), { input: 2, output: 2, calls: 1 }),
      okText("", read("3")),
      okUsage("", read("4"), { input: 3, output: 3, calls: 1 }),
      okUsage(FINDINGS, [], { input: 4, output: 4, calls: 1 }),
    ]);
    const out = await runAgent(h.conv, h.toolCtx, h.budget, h.hooks);
    expect(out.stop).toBe("final");
    expect(out.turns).toBe(5);
    expect(out.usage).toEqual({ input: 10, output: 10, calls: 4 });
  });

  it("carries no usage key when nothing observed", async () => {
    const root = tempRoot();
    const h = harness(root, [okText(FINDINGS)]);
    const out = await runAgent(h.conv, h.toolCtx, h.budget, h.hooks);
    expect(out.result).toEqual({ ok: true, findings: [] });
    expect(out).not.toHaveProperty("usage");
  });

  it("contributing turns then a failure: outcome accumulates, failed result carries no usage", async () => {
    const root = tempRoot();
    writeFileSync(join(root, "a.txt"), "hello\n");
    const h = harness(root, [
      okUsage("", [tc("1", "read_file", { path: "a.txt" })], { input: 5, output: 2, calls: 1 }),
      fail(500),
    ]);
    const out = await runAgent(h.conv, h.toolCtx, h.budget, h.hooks);
    expect(out.stop).toBe("error");
    expect(out.result.ok).toBe(false);
    expect(out.result).not.toHaveProperty("usage");
    expect(out.usage).toEqual({ input: 5, output: 2, calls: 1 });
  });

  it("a raced timeout contributes no usage (outcome absent)", async () => {
    vi.useFakeTimers();
    try {
      const root = tempRoot();
      const h = harness(root, [okUsage(FINDINGS, [], { input: 9, output: 9, calls: 1 })], { maxSeconds: 30 });
      h.hooks.call = () => new Promise<AgentReply>(() => {});
      const p = runAgent(h.conv, h.toolCtx, h.budget, h.hooks);
      await vi.advanceTimersByTimeAsync(30_000);
      const out = await p;
      expect(out.stop).toBe("budget");
      expect(out).not.toHaveProperty("usage");
    } finally {
      vi.useRealTimers();
    }
  });
});
