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
}

export interface AgentHooks {
  call: (
    conv: Conversation,
    flags: { allowTools: boolean; allowFormat: boolean },
    callOpts: { timeoutSeconds: number },
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
 * Cut `output` to at most `maxResultBytes` UTF-8 bytes without splitting a
 * code point: binary-search the longest string prefix whose UTF-8 byte
 * length fits, then step back if the cut lands inside a surrogate pair
 * (mirrors `codePointSafeCut` in agent-tools.ts). A raw byte cut could
 * split a multibyte sequence and decode to U+FFFD.
 */
function capOutput(output: string, maxResultBytes: number): string {
  if (Buffer.byteLength(output, "utf8") <= maxResultBytes) return output;
  let lo = 0;
  let hi = output.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(output.slice(0, mid), "utf8") <= maxResultBytes) lo = mid;
    else hi = mid - 1;
  }
  let cut = lo;
  if (cut > 0 && cut < output.length) {
    const code = output.charCodeAt(cut);
    if (code >= 0xdc00 && code <= 0xdfff) cut -= 1;
  }
  return output.slice(0, cut) + "[truncated]";
}

export async function runAgent(
  conv: Conversation,
  toolCtx: ToolContext,
  budget: AgentBudget,
  hooks: AgentHooks,
): Promise<AgentOutcome> {
  const clock = hooks.clock ?? Date.now;
  const start = clock();
  const deadline = start + budget.maxSeconds * 1000;
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
  const timeoutFor = (remaining: number): number => Math.min(budget.timeoutSeconds, Math.ceil(remaining / 1000));
  const timedOut = (): AgentOutcome | null => {
    if (deadline - clock() < 10_000) {
      return finish({ ok: false, reason: "timeout", detail: TIMEOUT_DETAIL }, "budget", false);
    }
    return null;
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
    const forced = turns >= budget.maxTurns || bytes >= maxTotalBytes;
    const flags = forced ? { ...NO_TOOLS } : { ...WITH_TOOLS };
    if (forced) turnsArr.push({ role: "user", text: BUDGET_NOTE });
    const turnStart = clock();
    const turnIndex = turns;
    const reply = await hooks.call(conv, flags, { timeoutSeconds: timeoutFor(remaining) });

    if (!reply.ok) {
      const status = statusOf(reply.result);
      // Turn-0 tool-call failure: a 400 means the endpoint rejects tools, so
      // retry the same conversation without them; a bare 404 advances the probe.
      if (turns === 0 && !forced) {
        if (status === 400) {
          const retryExpired = timedOut();
          if (retryExpired) return retryExpired;
          const retry = await hooks.call(conv, { ...NO_TOOLS }, { timeoutSeconds: timeoutFor(deadline - clock()) });
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
          const fixed = await hooks.call(conv, { ...NO_TOOLS }, { timeoutSeconds: timeoutFor(deadline - clock()) });
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
      const fixed = await hooks.call(conv, { ...NO_TOOLS }, { timeoutSeconds: timeoutFor(deadline - clock()) });
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
      let output: string;
      let isError: boolean;
      if (i < maxCalls) {
        const res = await executeTool(call.name, call.args, toolCtx);
        output = res.output;
        isError = res.isError;
        calls += 1;
      } else {
        output = `{"error":"too many tool calls in one turn (max ${maxCalls})"}`;
        isError = true;
      }
      output = capOutput(output, maxResultBytes);
      const n = Buffer.byteLength(output, "utf8");
      bytes += n;
      turnBytes += n;
      turnsArr.push(
        isError
          ? { role: "tool", id: call.id, name: call.name, output, isError: true }
          : { role: "tool", id: call.id, name: call.name, output },
      );
    }
    hooks.log(`agent turn ${turnIndex}: tools=[${reply.toolCalls.map((t) => t.name).join(",")}] results_bytes=${turnBytes} ms=${clock() - turnStart}`);
  }
}
