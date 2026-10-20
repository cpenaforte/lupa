import type { Finding } from "../domain/finding.js";
import type { ToolCall } from "../agent-types.js";
import type { ResolvedApiStyle } from "../providers.js";

export type LlmResult =
  | { ok: true; findings: Finding[]; verdicts?: DedupVerdicts; usage?: LlmUsage }
  | {
      ok: false;
      reason: "no-key" | "unsupported" | "timeout" | "content-filter" | "invalid-json";
      detail: string;
    }
  | {
      ok: false;
      reason: "http-error";
      detail: string;
      /** HTTP status behind the error, when a response existed; drives the style probe. */
      status?: number;
    };

/**
 * Aggregate LLM token usage (numbers only — never model text or prompts).
 * `calls` counts the contributing results: each adapter attaches 1 to the
 * result it produced; the agent loop's total adds the per-turn counts.
 */
export interface LlmUsage {
  input: number;
  output: number;
  calls: number;
}

/**
 * A single agent-mode turn reply: the assistant's text plus any tool calls it
 * requested. A failure keeps the single-shot LlmResult union so callers handle
 * both shapes identically. `rawItems` carries adapter-specific raw reply items
 * to echo verbatim on the next turn (unused by the chat adapter).
 */
export type AgentReply =
  | { ok: true; text: string; toolCalls: ToolCall[]; rawItems?: unknown[]; usage?: LlmUsage }
  | { ok: false; result: LlmResult };

/**
 * Dedup verdicts carried out-of-band alongside findings (positions stay
 * aligned because every pipeline stage is order-preserving):
 * - `pairs`: sent-list index pairs judged duplicates of each other.
 * - `links`: `[responseIndex, sentIndex]` pointers from model findings
 *   (which restate sent findings via `duplicateOf`) back to sent findings.
 * - `malformed`: count of shape-bad entries dropped at parse.
 */
export interface DedupVerdicts {
  pairs: Array<[number, number]>;
  links: Array<[number, number]>;
  malformed: number;
}

export type Attempt =
  | { kind: "fail"; result: LlmResult }
  | { kind: "response"; status: number; ok: boolean; retryAfter: string | null; text: string };

export interface ProbeOptions {
  maxTokens: number;
  timeoutSeconds: number;
  temperature?: number;
  topP?: number;
  /** Preserves the opencode-go x-opencode-session header across probe attempts. */
  prNumber?: number | null;
  /**
   * True when the base came from the user's llm_base_url input. Keeps the R3
   * /openai-rewrite warning honest: only a USER-supplied base may trigger it,
   * never the probe's rebuild of a preset-derived base.
   */
  userBase?: boolean;
}

export interface ProbeOutcome {
  result: LlmResult;
  /** The style whose adapter produced the result; set whenever a call was made. */
  via?: ResolvedApiStyle;
}

export type AgentCallOptions = {
  model: string;
  apiKey: string;
  temperature?: number;
  topP?: number;
  maxTokens: number;
  timeoutSeconds: number;
  provider: string;
  maxTurns: number;
  maxSeconds: number;
};
