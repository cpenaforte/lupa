import * as core from "@actions/core";
import type { AnalysisPolicy } from "./domain/assessment.js";
import { AGENT_RESERVE_SECONDS } from "./agent-types.js";

export type FailLevel = "none" | "warning" | "high";

export const LLM_PROVIDERS = [
  "openai",
  "anthropic",
  "google",
  "groq",
  "mistral",
  "openrouter",
  "ollama",
  "opencode-zen",
  "opencode-go",
  "custom",
] as const;

export const LLM_API_STYLES = [
  "auto",
  "openai-chat",
  "openai-responses",
  "anthropic-messages",
  "google-models",
  "custom-path",
] as const;

export type LlmProvider = (typeof LLM_PROVIDERS)[number];
export type LlmApiStyle = (typeof LLM_API_STYLES)[number];

export interface ActionInputs {
  githubToken: string;
  reviewActor?: string;
  llmProvider: LlmProvider;
  llmBaseUrl: string;
  llmApiStyle: LlmApiStyle;
  llmPath: string;
  llmModel: string;
  llmApiKey: string;
  llmTemperature?: number;
  llmTopP?: number;
  llmMaxTokens: number;
  failLevel: FailLevel;
  analysisPolicy?: AnalysisPolicy;
  maxDiffChars: number;
  maxPromptChars: number;
  maxFindings: number;
  maxInlineComments: number;
  maxReviewBodyChars: number;
  maxArtifactBytes: number;
  postComment: boolean;
  timeoutSeconds: number;
  prNumber: number | null;
  llmAgent: boolean;
  llmAgentMaxTurns: number;
  llmAgentMaxSeconds: number;
}

export const DEFAULT_MAX_FINDINGS = 200;
export const DEFAULT_MAX_INLINE_COMMENTS = 30;
export const DEFAULT_MAX_REVIEW_BODY_CHARS = 60000;
export const DEFAULT_MAX_ARTIFACT_BYTES = 8388608;
/** Shared floor: holds the bounded fallback assessment (413 bytes with 40-char SHAs) and pr-meta.json (263 bytes). */
export const MIN_ARTIFACT_BYTES = 1024;

export function parseFailLevel(v: string): FailLevel {
  if (v === "none" || v === "warning" || v === "high") return v;
  throw new Error(`Invalid fail_level "${v}": expected none, warning, or high`);
}

/** A workflow-owned GitHub login, optionally using the documented bot suffix. */
export function parseReviewActor(raw: string): string | undefined {
  if (raw === "") return undefined;
  if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?(?:\[bot\])?$/i.test(raw) || raw.includes("--")) {
    throw new Error("Invalid review_actor: expected a GitHub login, optionally ending in [bot]");
  }
  return raw;
}

// core.getInput already trims whitespace (trimWhitespace defaults to true).
function readString(name: string, fallback = ""): string {
  const v = core.getInput(name);
  return v === "" ? fallback : v;
}

function parseIntValue(name: string, raw: string, min: number, max?: number): number {
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < min || (max !== undefined && n > max)) {
    const range = max === undefined ? `>= ${min}` : `between ${min} and ${max}`;
    throw new Error(`Invalid ${name} "${raw}": expected an integer ${range} (safe integer)`);
  }
  return n;
}

function readInt(name: string, fallback: number, min: number, max?: number): number {
  const raw = readString(name);
  if (raw === "") return fallback;
  return parseIntValue(name, raw, min, max);
}

function readOptionalDecimal(name: string): number | undefined {
  const raw = readString(name);
  if (raw === "") return undefined;
  const n = Number(raw);
  if (!/^-?\d+(\.\d+)?$/.test(raw) || !Number.isFinite(n)) {
    throw new Error(`Invalid ${name} "${raw}": expected a finite decimal number (e.g. 0.7)`);
  }
  return n;
}

function readBool(name: string, fallback: boolean): boolean {
  const raw = readString(name);
  if (raw === "") return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`Invalid ${name} "${raw}": expected true or false`);
}

function readEnum<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const raw = readString(name);
  if (raw === "") return fallback;
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  throw new Error(`Invalid ${name} "${raw}": expected one of ${allowed.join(", ")}`);
}

export function getInputs(): ActionInputs {
  const llmTemperature = readOptionalDecimal("llm_temperature");
  const llmTopP = readOptionalDecimal("llm_top_p");
  const prNumber = readOptionalInt("pr_number", 1);
  const reviewActor = parseReviewActor(core.getInput("review_actor", { trimWhitespace: false }));

  return {
    githubToken: readString("github_token"),
    ...(reviewActor !== undefined ? { reviewActor } : {}),
    llmProvider: readEnum("llm_provider", LLM_PROVIDERS, "openai"),
    llmBaseUrl: readString("llm_base_url"),
    llmApiStyle: readEnum("llm_api_style", LLM_API_STYLES, "auto"),
    llmPath: readString("llm_path"),
    llmModel: readString("llm_model"),
    llmApiKey: readString("llm_api_key"),
    ...(llmTemperature !== undefined ? { llmTemperature } : {}),
    ...(llmTopP !== undefined ? { llmTopP } : {}),
    llmMaxTokens: readInt("llm_max_tokens", 2000, 1),
    failLevel: parseFailLevel(readString("fail_level", "warning")),
    analysisPolicy: readEnum("analysis_policy", ["advisory", "required"] as const, "advisory"),
    maxDiffChars: readInt("max_diff_chars", 60000, 1),
    maxPromptChars: readInt("max_prompt_chars", 120000, 1),
    maxFindings: readInt("max_findings", DEFAULT_MAX_FINDINGS, 1),
    maxInlineComments: readInt("max_inline_comments", DEFAULT_MAX_INLINE_COMMENTS, 1),
    maxReviewBodyChars: readInt("max_review_body_chars", DEFAULT_MAX_REVIEW_BODY_CHARS, 1000),
    maxArtifactBytes: readInt("max_artifact_bytes", DEFAULT_MAX_ARTIFACT_BYTES, MIN_ARTIFACT_BYTES),
    postComment: readBool("post_comment", true),
    timeoutSeconds: readInt("timeout_seconds", 90, 1),
    prNumber,
    llmAgent: readBool("llm_agent", false),
    llmAgentMaxTurns: readInt("llm_agent_max_turns", 10, 1),
    llmAgentMaxSeconds: readInt("llm_agent_max_seconds", 180, AGENT_RESERVE_SECONDS + 1, 21600),
  };
}

// Single read: empty means not-set (null); otherwise validated by parseIntValue.
function readOptionalInt(name: string, min: number): number | null {
  const raw = readString(name);
  if (raw === "") return null;
  return parseIntValue(name, raw, min);
}
