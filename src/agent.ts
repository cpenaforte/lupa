import { AGENT_LIMITS } from "./agent-types.js";
import type { Conversation, ToolCall } from "./agent-types.js";
import { executeTool } from "./agent-tools.js";
import type { ToolContext } from "./agent-tools.js";
import { parseContent, toFindings } from "./llm.js";
import type { AgentReply, LlmResult } from "./llm.js";

export interface AgentBudget {
  maxTurns: number;
  maxSeconds: number;
  timeoutSeconds: number;
  maxResultBytes?: number;
  maxTotalBytes?: number;
  maxCallsPerTurn?: number;
  /** Absolute epoch-ms deadline; when present runAgent uses it verbatim. */
  deadlineMs?: number;
}

export interface AgentHooks {
  call: (
    conv: Conversation,
    flags: { allowTools: boolean; allowFormat: boolean },
    callOpts: { timeoutSeconds: number; deadlineMs: number },
  ) => Promise<AgentReply>;
  log: (msg: string) => void;
  clock?: () => number;
}

export interface AgentOutcome {
  result: LlmResult;
  stop: "final" | "budget" | "fallback" | "error";
  probeAdvance: boolean;
  toolsUnsupported: boolean;
  turns: number;
  calls: number;
  bytes: number;
  elapsedMs: number;
}

const BUDGET_NOTE = "Tool budget exhausted. Respond with ONLY the JSON findings object matching the schema.";
const REPAIR_NOTE =
  "Your previous message was not valid JSON. Respond with ONLY the JSON findings object matching the schema; no prose.";
const TIMEOUT_DETAIL = "agent budget exhausted";
const NO_TOOLS = { allowTools: false, allowFormat: true } as const;
const WITH_TOOLS = { allowTools: true, allowFormat: false } as const;
/** Byte length of the "\n[truncated]" marker: below this no content output fits. */
const MARKER_BYTES = 12;
/** Backstop envelope replacing over-cap or corrupt tool output (65 B, valid JSON). */
const OVER_BUDGET_ENVELOPE = '{"error":"tool result exceeded the byte budget","truncated":true}';

function statusOf(result: LlmResult): number | undefined {
  return !result.ok && result.reason === "http-error" ? result.status : undefined;
}

function tryParseFinal(text: string): LlmResult {
  let parsed: unknown;
  try {
    parsed = parseContent(text);
  } catch (e) {
    return { ok: false, reason: "invalid-json", detail: e instanceof Error ? e.message : String(e) };
  }
  const findings = toFindings(parsed);
  if (findings === undefined) {
    return { ok: false, reason: "invalid-json", detail: "response does not match the review schema" };
  }
  return { ok: true, findings };
}

/**
 * Backstop for tool output: output that parses as JSON and fits in
 * `maxBytes` UTF-8 bytes passes through unchanged; over-cap or corrupt
 * (non-JSON) output is replaced with a fixed error envelope so the model
 * always sees valid JSON within the byte allowance.
 */
export function capToolResult(output: string, maxBytes: number): string {
  try {
    JSON.parse(output);
  } catch {
    return OVER_BUDGET_ENVELOPE;
  }
  if (Buffer.byteLength(output, "utf8") <= maxBytes) return output;
  return OVER_BUDGET_ENVELOPE;
}

export async function runAgent(
  conv: Conversation,
  toolCtx: ToolContext,
  budget: AgentBudget,
  hooks: AgentHooks,
): Promise<AgentOutcome> {
  const clock = hooks.clock ?? Date.now;
  const start = clock();
  const deadline = budget.deadlineMs ?? start + budget.maxSeconds * 1000;
  const maxCalls = budget.maxCallsPerTurn ?? AGENT_LIMITS.maxCallsPerTurn;
  const maxResultBytes = budget.maxResultBytes ?? AGENT_LIMITS.resultBytes;
  const maxTotalBytes = budget.maxTotalBytes ?? AGENT_LIMITS.totalBytes;
  const turnsArr = conv.turns ?? (conv.turns = []);
  let turns = 0;
  let calls = 0;
  let bytes = 0;
  let toolsUnsupported = false;

  const elapsedMs = (): number => clock() - start;
  const finish = (
    result: LlmResult,
    stop: AgentOutcome["stop"],
    probeAdvance: boolean,
  ): AgentOutcome => {
    const ms = elapsedMs();
    hooks.log(`agent done: turns=${turns} calls=${calls} bytes=${bytes} stop=${stop} elapsed=${ms / 1000}s`);
    return { result, stop, probeAdvance, toolsUnsupported, turns, calls, bytes, elapsedMs: ms };
  };
  const timeoutFor = (remaining: number): number =>
    Math.max(1, Math.min(budget.timeoutSeconds, Math.floor(remaining / 1000)));
  const timedOut = (): AgentOutcome | null => {
    if (deadline - clock() < 10_000) {
      return finish({ ok: false, reason: "timeout", detail: TIMEOUT_DETAIL }, "budget", false);
    }
    return null;
  };
  const timeoutLlmResult = (): LlmResult => ({ ok: false, reason: "timeout", detail: TIMEOUT_DETAIL });
  const timeoutReply = (): AgentReply => ({ ok: false, result: timeoutLlmResult() });

  /**
   * Races one model call against the absolute deadline. `nowMs` is passed in
   * from the already-read clock values at each call site (never read here).
   * `ms <= 0` returns the timeout result WITHOUT invoking `hooks.call`; else
   * a real-timer fallback resolves the same timeout result, the timer is
   * cleared on settle, and the dangling inner promise gets a noop catch.
   */
  const callWithDeadline = (
    flags: { allowTools: boolean; allowFormat: boolean },
    opts: { timeoutSeconds: number; deadlineMs: number },
    nowMs: number,
  ): Promise<{ reply: AgentReply; raced: boolean }> => {
    const ms = deadline - nowMs;
    if (ms <= 0) return Promise.resolve({ reply: timeoutReply(), raced: true });
    // The model call starts before the race timer so a synchronous throw
    // cannot leak a live timer (async adapters are unaffected: the timer
    // still guards the in-flight promise identically).
    const inner = hooks.call(conv, flags, opts);
    // Adapters resolve by contract and never reject; this is timer hygiene
    // for the dangling promise after a race win.
    inner.then(undefined, () => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutP = new Promise<{ reply: AgentReply; raced: boolean }>((resolve) => {
      timer = setTimeout(() => resolve({ reply: timeoutReply(), raced: true }), ms);
    });
    return Promise.race([inner.then((reply) => ({ reply, raced: false as const })), timeoutP]).finally(() => {
      clearTimeout(timer);
    });
  };

  const appendAssistant = (reply: { text: string; toolCalls: ToolCall[]; rawItems?: unknown[] }): void => {
    turnsArr.push({
      role: "assistant",
      text: reply.text,
      toolCalls: reply.toolCalls,
      ...(reply.rawItems !== undefined ? { rawItems: reply.rawItems } : {}),
    });
  };

  for (;;) {
    const expired = timedOut();
    if (expired) return expired;
    const remaining = deadline - clock();
    const forced = turns >= budget.maxTurns || bytes >= maxTotalBytes || maxTotalBytes - bytes < MARKER_BYTES;
    const flags = forced ? { ...NO_TOOLS } : { ...WITH_TOOLS };
    if (forced) turnsArr.push({ role: "user", text: BUDGET_NOTE });
    const turnStart = clock();
    const turnIndex = turns;
    const nowMs = deadline - remaining;
    const first = await callWithDeadline(flags, { timeoutSeconds: timeoutFor(remaining), deadlineMs: deadline }, nowMs);
    if (first.raced) return finish(timeoutLlmResult(), "budget", false);
    const reply = first.reply;

    if (!reply.ok) {
      const status = statusOf(reply.result);
      // Turn-0 tool-call failure: a 400 means the endpoint rejects tools, so
      // retry the same conversation without them; a bare 404 advances the probe.
      if (turns === 0 && !forced) {
        if (status === 400) {
          const retryExpired = timedOut();
          if (retryExpired) return retryExpired;
          const retryRemaining = deadline - clock();
          const retried = await callWithDeadline(
            { ...NO_TOOLS },
            { timeoutSeconds: timeoutFor(retryRemaining), deadlineMs: deadline },
            deadline - retryRemaining,
          );
          if (retried.raced) return finish(timeoutLlmResult(), "budget", false);
          const retry = retried.reply;
          if (!retry.ok) {
            const s2 = statusOf(retry.result);
            toolsUnsupported = true;
            return finish(retry.result, "fallback", s2 === 400 || s2 === 404);
          }
          const parsed = tryParseFinal(retry.text);
          appendAssistant(retry);
          if (parsed.ok) {
            turns += 1;
            toolsUnsupported = true;
            return finish(parsed, "fallback", false);
          }
          turnsArr.push({ role: "user", text: REPAIR_NOTE });
          const repairExpired = timedOut();
          if (repairExpired) return repairExpired;
          const repairRemaining = deadline - clock();
          const repaired = await callWithDeadline(
            { ...NO_TOOLS },
            { timeoutSeconds: timeoutFor(repairRemaining), deadlineMs: deadline },
            deadline - repairRemaining,
          );
          if (repaired.raced) return finish(timeoutLlmResult(), "budget", false);
          const fixed = repaired.reply;
          if (!fixed.ok) {
            toolsUnsupported = true;
            return finish(fixed.result, "error", false);
          }
          turns += 2;
          appendAssistant(fixed);
          const p2 = tryParseFinal(fixed.text);
          toolsUnsupported = true;
          if (p2.ok) return finish(p2, "fallback", false);
          return finish(p2, "error", false);
        }
        if (status === 404) return finish(reply.result, "error", true);
        return finish(reply.result, "error", false);
      }
      return finish(reply.result, "error", false);
    }

    if (forced) {
      appendAssistant(reply);
      turns += 1;
      hooks.log(`agent turn ${turnIndex}: tools=[] results_bytes=0 ms=${clock() - turnStart}`);
      const parsed = tryParseFinal(reply.text);
      if (parsed.ok) return finish(parsed, "budget", false);
      return finish(parsed, "error", false);
    }

    if (reply.toolCalls.length === 0) {
      appendAssistant(reply);
      turns += 1;
      const parsed = tryParseFinal(reply.text);
      if (parsed.ok) {
        hooks.log(`agent turn ${turnIndex}: tools=[] results_bytes=0 ms=${clock() - turnStart}`);
        return finish(parsed, "final", false);
      }
      hooks.log(`agent turn ${turnIndex}: tools=[] results_bytes=0 ms=${clock() - turnStart}`);
      turnsArr.push({ role: "user", text: REPAIR_NOTE });
      const repairExpired = timedOut();
      if (repairExpired) return repairExpired;
      const repairStart = clock();
      const repairRemaining = deadline - clock();
      const repaired = await callWithDeadline(
        { ...NO_TOOLS },
        { timeoutSeconds: timeoutFor(repairRemaining), deadlineMs: deadline },
        deadline - repairRemaining,
      );
      if (repaired.raced) return finish(timeoutLlmResult(), "budget", false);
      const fixed = repaired.reply;
      if (!fixed.ok) return finish(fixed.result, "error", false);
      appendAssistant(fixed);
      turns += 1;
      const p2 = tryParseFinal(fixed.text);
      hooks.log(`agent turn ${turnIndex + 1}: tools=[] results_bytes=0 ms=${clock() - repairStart}`);
      if (p2.ok) return finish(p2, "final", false);
      return finish(p2, "error", false);
    }

    appendAssistant(reply);
    turns += 1;
    let turnBytes = 0;
    for (let i = 0; i < reply.toolCalls.length; i++) {
      const call = reply.toolCalls[i]!;
      if (i >= maxCalls) {
        // Too-many-calls record is loop-generated bookkeeping: excluded
        // from `bytes` (content outputs alone are counted).
        turnsArr.push({
          role: "tool",
          id: call.id,
          name: call.name,
          output: `{"error":"too many tool calls in one turn (max ${maxCalls})"}`,
          isError: true,
        });
        continue;
      }
      const remainingBytes = maxTotalBytes - bytes;
      if (remainingBytes < MARKER_BYTES) {
        // Below this no content output can fit: skip execution without
        // incrementing `calls`; the record itself is bookkeeping-excluded.
        turnsArr.push({
          role: "tool",
          id: call.id,
          name: call.name,
          output: `{"error":"tool result budget exhausted (max ${maxTotalBytes} bytes)"}`,
          isError: true,
        });
        continue;
      }
      const effective = Math.min(maxResultBytes, remainingBytes);
      const res = await executeTool(call.name, call.args, toolCtx, {
        deadlineMs: Date.now() + Math.max(0, deadline - clock()),
        maxResultBytes: Math.min(maxResultBytes, remainingBytes),
      });
      calls += 1;
      const output = capToolResult(res.output, effective);
      const replaced = output !== res.output;
      const isError = res.isError || replaced;
      if (!replaced) {
        const n = Buffer.byteLength(output, "utf8");
        bytes += n;
        turnBytes += n;
      }
      turnsArr.push(
        isError
          ? { role: "tool", id: call.id, name: call.name, output, isError: true }
          : { role: "tool", id: call.id, name: call.name, output },
      );
    }
    hooks.log(`agent turn ${turnIndex}: tools=[${reply.toolCalls.map((t) => t.name).join(",")}] results_bytes=${turnBytes} ms=${clock() - turnStart}`);
  }
}
