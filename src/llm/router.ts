import { createRequestContext, type RequestContext } from "../runtime/context.js";
import { stripProvenance } from "../domain/finding.js";
import type { Conversation } from "../agent-types.js";
import { buildEndpointForStyle } from "../providers.js";
import type { ApiStyle, ResolvedApiStyle, ResolvedEndpoint } from "../providers.js";
import { callGoogle, callGoogleTurn } from "../adapters/google.js";
import { callMessages, callMessagesTurn } from "../adapters/messages.js";
import { callResponses, callResponsesTurn } from "../adapters/responses.js";
import { runAgent, type AgentOutcome } from "../agent.js";
import type { ToolContext } from "../agent-tools.js";
import * as core from "@actions/core";
import { redact } from "../domain/text.js";
import type { AgentCallOptions, AgentReply, LlmResult, ProbeOptions, ProbeOutcome } from "./types.js";
import { callLlm, callChatTurn } from "./chat.js";

/**
 * Dispatches to the adapter of the endpoint's resolved API style: openai-chat
 * keeps callLlm; the v2 styles route to their native-protocol adapters. Same
 * messages/options shape and the same LlmResult union for every style, so
 * callers handle the result identically.
 */
export async function callByStyle(
  ep: ResolvedEndpoint,
  messages: { system: string; user: string },
  o: {
    model: string;
    apiKey: string;
    temperature?: number;
    topP?: number;
    maxTokens: number;
    timeoutSeconds: number;
    context?: RequestContext;
    provider: string;
  },
): Promise<LlmResult> {
  const observed = async (result: Promise<LlmResult>): Promise<LlmResult> => {
    const r = await result;
    return { ...r, execution: { mode: "single-shot", status: r.ok ? "completed" : "failed" } };
  };
  // No fallback for a missing/malformed apiStyle: resolveEndpoint always sets it,
  // so an endpoint without one is a programming error that should fail loudly.
  switch (ep.apiStyle) {
    case "openai-responses":
      return observed(callResponses(ep, messages, o));
    case "anthropic-messages":
      return observed(callMessages(ep, messages, o));
    case "google-models":
      // Google posts to {base}/models/<id>:generateContent: the model id rides the path.
      return observed(callGoogle(ep, o.model, messages, o));
    case "openai-chat":
      return observed(callLlm(ep, messages, o));
    default:
      // Unreachable by type; guards forged/malformed endpoints at runtime.
      throw new Error("unsupported apiStyle: " + String(ep.apiStyle));
  }
}

// ---------------------------------------------------------------------------
// Error-driven style routing (spec §9.5): no hardcoded (provider,model)->style
// map. `auto` walks the probe order and learns the style from 400/404 errors;
// the catalog GET /models check stays the only existence source of truth.
// Probing is safe by construction: adapters only generate text (read-only,
// idempotent) — they never write.
// ---------------------------------------------------------------------------

/** Probe order for `auto`: chat first (the common case), then the native styles. */
export const PROBE_ORDER = ["openai-chat", "openai-responses", "anthropic-messages", "google-models"] as const;

/** In-process memo of the style that worked, keyed provider:model (session determinism). */
const PROBE_MEMO = new Map<string, ResolvedApiStyle>();

/** Test-only: clears the in-process style memo (production never resets it). */
export function resetProbeMemo(): void {
  PROBE_MEMO.clear();
}

/**
 * Only a 400 or 404 advances the probe (route/contract error: the endpoint or
 * the body shape is wrong for this style). 429/5xx belong to the adapter's own
 * retry; every other outcome (timeout, refusal, content filter, bad JSON, auth
 * error) is not a style signal. The numeric `status` on the http-error result
 * is the contract (set by every adapter); the detail regex stays as a fallback
 * for http-errors emitted without a status.
 */
function isProbeTrigger(result: LlmResult): boolean {
  if (result.ok || result.reason !== "http-error") return false;
  if (result.status !== undefined) return result.status === 400 || result.status === 404;
  return /^HTTP (400|404)(?!\d)/.test(result.detail);
}

/**
 * Error-driven routing (spec §9.5). An explicit style is honored as-is: one
 * call, no probe. `auto` (or no style) walks PROBE_ORDER and memoizes the
 * style that worked for the process. A 400/404 advances to the next style and
 * invalidates any memoized style for the pair (contract drift: the probe
 * continues through the remaining styles instead of dead-ending); any other
 * failure is returned as-is. When every tried style answers 400/404 the
 * result is http-error carrying the last (redacted) detail and status, plus a
 * warning naming the model and every style tried.
 */
export async function callWithProbe(
  provider: string,
  model: string,
  baseUrl: string,
  key: string,
  messages: { system: string; user: string },
  o: ProbeOptions,
  explicitStyle?: Exclude<ApiStyle, "custom-path">,
): Promise<ProbeOutcome> {
  if (key === "") {
    return { result: { ok: false, reason: "no-key", detail: "no API key configured" } };
  }

  const callOpts = {
    model,
    apiKey: key,
    temperature: o.temperature,
    topP: o.topP,
    maxTokens: o.maxTokens,
    timeoutSeconds: o.timeoutSeconds,
    context: o.context,
    provider,
  };

  const run = async (style: ResolvedApiStyle): Promise<ProbeOutcome> => {
    const ep = buildEndpointForStyle(provider, model, baseUrl, key, style, o.prNumber ?? null, o.userBase ?? false);
    return { result: await callByStyle(ep, messages, callOpts), via: style };
  };

  // Explicit style: the user decided; exactly one call, no probe.
  if (explicitStyle !== undefined && explicitStyle !== "auto") {
    return run(explicitStyle);
  }

  const memoKey = `${provider}:${model}`;
  const memoized = PROBE_MEMO.get(memoKey);
  // A stale memo must not dead-end the probe: the memoized style goes first,
  // then every other style in PROBE_ORDER order.
  const order: readonly ResolvedApiStyle[] =
    memoized !== undefined ? [memoized, ...PROBE_ORDER.filter((s) => s !== memoized)] : PROBE_ORDER;

  const attempted: ResolvedApiStyle[] = [];
  let last: LlmResult | undefined;
  for (const style of order) {
    attempted.push(style);
    const out = await run(style);
    if (out.result.ok) {
      PROBE_MEMO.set(memoKey, style);
      return out;
    }
    last = out.result;
    if (!isProbeTrigger(last)) return out;
    // A 400/404 invalidates any memoized style for this pair: drop it and
    // keep probing through the remaining styles.
    PROBE_MEMO.delete(memoKey);
  }

  // Every tried style answered 400/404: report the last failure, name what was tried.
  core.warning(
    `model "${model}": no API style accepted the request; tried ${attempted.join(" → ")}. ` +
      `Set llm_api_style explicitly to skip the probe.`,
  );
  const detail = last !== undefined && !last.ok ? last.detail : "no API style accepted the request";
  const status = last !== undefined && !last.ok && last.reason === "http-error" ? last.status : undefined;
  return {
    result: {
      ok: false,
      reason: "http-error",
      detail: redact(detail, key),
      ...(status !== undefined ? { status } : {}),
    },
    via: attempted.at(-1),
  };
}

// ---------------------------------------------------------------------------
// Agent-mode probe integration: the same error-driven style walk, but each
// style runs the tool loop (runAgent) instead of a single shot. A model that
// rejects tools falls back to single-shot for the rest of the process.
// ---------------------------------------------------------------------------

/** In-process memo of models that reject tools, keyed provider:model. */
const TOOLS_MEMO = new Map<string, boolean>();

/** Test-only: clears the in-process tools memo (production never resets it). */
export function resetToolsMemo(): void {
  TOOLS_MEMO.clear();
}

/**
 * Dispatches one agent turn to the adapter of the endpoint's resolved API
 * style. Same options shape as `callByStyle`; the `flags` gate the
 * tool/format fields exactly like the per-adapter turn calls.
 */
export async function callTurnByStyle(
  ep: ResolvedEndpoint,
  conv: Conversation,
  o: {
    model: string;
    apiKey: string;
    temperature?: number;
    topP?: number;
    maxTokens: number;
    timeoutSeconds: number;
    context?: RequestContext;
    provider: string;
  },
  flags: { allowTools: boolean; allowFormat: boolean },
): Promise<AgentReply> {
  // No fallback for a missing/malformed apiStyle: resolveEndpoint always sets it,
  // so an endpoint without one is a programming error that should fail loudly.
  switch (ep.apiStyle) {
    case "openai-responses":
      return callResponsesTurn(ep, conv, o, flags);
    case "anthropic-messages":
      return callMessagesTurn(ep, conv, o, flags);
    case "google-models":
      // Google posts to {base}/models/<id>:generateContent: the model id rides the path.
      return callGoogleTurn(ep, o.model, conv, o, flags);
    case "openai-chat":
      return callChatTurn(ep, conv, o, flags);
    default:
      // Unreachable by type; guards forged/malformed endpoints at runtime.
      throw new Error("unsupported apiStyle: " + String(ep.apiStyle));
  }
}

/**
 * Binds one agent-loop turn to `callTurnByStyle` on a fixed endpoint. The
 * per-turn timeout from the loop overrides the base timeout, mirroring the
 * remaining-budget behavior of the agent runner.
 */
function agentCallFor(ep: ResolvedEndpoint, o: AgentCallOptions) {
  return (
    c: Conversation,
    flags: { allowTools: boolean; allowFormat: boolean },
    callOpts: { timeoutSeconds: number; context?: RequestContext },
  ): Promise<AgentReply> =>
    callTurnByStyle(
      ep,
      c,
      {
        model: o.model,
        apiKey: o.apiKey,
        temperature: o.temperature,
        topP: o.topP,
        maxTokens: o.maxTokens,
        timeoutSeconds: callOpts.timeoutSeconds,
        context: callOpts.context,
        provider: o.provider,
      },
      flags,
    );
}

/**
 * Propagates the agent-loop usage total onto an ok:true result (overwriting any
 * single-turn value — the total supersedes it). Conditional so no explicit
 * `usage: undefined` key is written; ok:false results never carry usage.
 */
function withAgentUsage(outcome: AgentOutcome, result: LlmResult): LlmResult {
  return { ...result, ...(result.ok && outcome.usage !== undefined ? { usage: outcome.usage } : {}),
    execution: { mode: "agent", status: !result.ok ? "failed" : outcome.toolsUnsupported ? "fallback" : outcome.stop === "budget" ? "budget" : "completed",
      ...(outcome.toolsUnsupported ? { reason: "tools-unsupported" } : {}) } };
}

/**
 * Runs the agent tool loop against one already-resolved endpoint. The `agent
 * done` summary is logged through runAgent; the loop's final result is
 * returned directly.
 */
export async function callByStyleAgent(
  ep: ResolvedEndpoint,
  conv: Conversation,
  o: AgentCallOptions,
  toolCtx: ToolContext,
): Promise<LlmResult> {
  const outcome = await runAgent(
    conv,
    toolCtx,
    { maxTurns: o.maxTurns, maxSeconds: o.maxSeconds, timeoutSeconds: o.timeoutSeconds, context: o.context },
    { call: agentCallFor(ep, o), log: core.info },
  );
  return withAgentUsage(outcome, outcome.result);
}

/**
 * Agent-mode error-driven routing. Like `callWithProbe` but each style runs
 * the tool loop: an explicit style is honored as-is (one loop, no probe),
 * otherwise the memoized style goes first and a 400/404 advances to the next
 * style. A turn-0 400 that succeeds without tools marks the model as
 * tools-unsupported (single-shot fallback, memoized); a 400 that fails even
 * without tools advances the probe instead — the style itself is wrong, so
 * the advance wins over the tools fallback. Any other outcome is returned
 * as-is. When every tried style fails the result is http-error carrying the
 * last (redacted) detail and status, plus a warning naming the model and
 * every style tried.
 */
export async function callWithProbeAgent(
  provider: string,
  model: string,
  baseUrl: string,
  key: string,
  conv: Conversation,
  o: ProbeOptions & { maxTurns: number; maxSeconds: number },
  toolCtx: ToolContext,
  explicitStyle?: Exclude<ApiStyle, "custom-path">,
): Promise<ProbeOutcome> {
  if (key === "") {
    return { result: { ok: false, reason: "no-key", detail: "no API key configured" } };
  }

  const owned = o.context === undefined ? createRequestContext(o.maxSeconds * 1000) : undefined;
  o = { ...o, context: o.context ?? owned!.context };
  try {
    const memoKey = `${provider}:${model}`;

    // A model that already proved it rejects tools skips the loop entirely.
    // The conversation has no turns at this point, so this is single-shot.
    // Agent-mode findings carry no provenance (Q04): strip them here while
    // keeping the genuine single-shot `verdicts` judgment.
    if (TOOLS_MEMO.get(memoKey) === false) {
      core.info("agent tools unsupported for this model: using single-shot");
      const out = await callWithProbe(provider, model, baseUrl, key, { system: conv.system, user: conv.user }, o, explicitStyle);
      if (out.result.ok) {
        out.result.findings = out.result.findings.map(stripProvenance);
      }
      out.result = { ...out.result, execution: { mode: "agent", status: out.result.ok ? "fallback" : "failed", reason: "tools-unsupported" } };
      return out;
    }

    const agentOpts: AgentCallOptions = {
      model,
      apiKey: key,
      temperature: o.temperature,
      topP: o.topP,
      maxTokens: o.maxTokens,
      timeoutSeconds: o.timeoutSeconds,
      context: o.context,
      provider,
      maxTurns: o.maxTurns,
      maxSeconds: o.maxSeconds,
    };

    // One absolute deadline per probe invocation: every probed style shares
    // it instead of restarting the clock (real-clock; the agent loop derives
    // per-call timeouts from it).
    const deadlineMs = o.context!.deadlineMs;

    const runStyle = async (style: ResolvedApiStyle) => {
      const ep = buildEndpointForStyle(provider, model, baseUrl, key, style, o.prNumber ?? null, o.userBase ?? false);
      const outcome = await runAgent(
        conv,
        toolCtx,
        { maxTurns: o.maxTurns, maxSeconds: o.maxSeconds, timeoutSeconds: o.timeoutSeconds, deadlineMs, context: o.context },
        { call: agentCallFor(ep, agentOpts), log: core.info },
      );
      return { outcome, via: style };
    };

    // Explicit style: the user decided; exactly one loop, no probe.
    if (explicitStyle !== undefined && explicitStyle !== "auto") {
      const { outcome } = await runStyle(explicitStyle);
      return { result: withAgentUsage(outcome, outcome.result), via: explicitStyle };
    }

    // A stale memo must not dead-end the probe: the memoized style goes first,
    // then every other style in PROBE_ORDER order.
    const memoized = PROBE_MEMO.get(memoKey);
    const order: readonly ResolvedApiStyle[] =
      memoized !== undefined ? [memoized, ...PROBE_ORDER.filter((s) => s !== memoized)] : PROBE_ORDER;

    const attempted: ResolvedApiStyle[] = [];
    let last: LlmResult | undefined;
    for (const style of order) {
      attempted.push(style);
      const { outcome } = await runStyle(style);
      last = outcome.result;
      if (outcome.probeAdvance) {
        // A 400/404 invalidates any memoized style for this pair: drop it and
        // keep probing through the remaining styles. This wins over the tools
        // fallback below: a 400 that fails even without tools means the style
        // itself is wrong.
        PROBE_MEMO.delete(memoKey);
        continue;
      }
      if (outcome.toolsUnsupported) {
        // The loop fell back to single-shot: remember it for this model. The
        // result may still be ok (fallback success), so this check must come
        // before the ok branch.
        TOOLS_MEMO.set(memoKey, false);
        return { result: withAgentUsage(outcome, outcome.result), via: style };
      }
      if (outcome.result.ok) {
        PROBE_MEMO.set(memoKey, style);
        return { result: withAgentUsage(outcome, outcome.result), via: style };
      }
      return { result: withAgentUsage(outcome, outcome.result), via: style };
    }

    // Every tried style failed: report the last failure, name what was tried.
    core.warning(
      `model "${model}": no API style accepted the request; tried ${attempted.join(" → ")}. ` +
        `Set llm_api_style explicitly to skip the probe.`,
    );
    const detail = last !== undefined && !last.ok ? last.detail : "no API style accepted the request";
    const status = last !== undefined && !last.ok && last.reason === "http-error" ? last.status : undefined;
    return {
      result: {
        ok: false,
        reason: "http-error",
        detail: redact(detail, key),
        ...(status !== undefined ? { status } : {}),
      },
      via: attempted.at(-1),
    };
  } finally {
    owned?.dispose();
  }
}
