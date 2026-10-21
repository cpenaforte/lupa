// Compatibility facade. Implementation modules import the owning leaves directly.
export { redact } from "./domain/text.js";
export type {
  LlmResult, LlmUsage, AgentReply, DedupVerdicts, Attempt, ProbeOptions, ProbeOutcome,
} from "./llm/types.js";
export { InvalidJsonError, parseContent, parseVerdicts, extractUsage, toFindings } from "./llm/schema.js";
export { validateSampling, tokenFieldFor } from "./llm/sampling.js";
export {
  OllamaMissingError, SNIPPET_CHARS, errMessage, retryDelayMs, sleep, waitForRetry, attempt, ensureOllama,
} from "./llm/transport.js";
export { callLlm, callChatTurn } from "./llm/chat.js";
export {
  callByStyle, PROBE_ORDER, resetProbeMemo, callWithProbe, resetToolsMemo,
  callTurnByStyle, callByStyleAgent, callWithProbeAgent,
} from "./llm/router.js";

export { createRequestContext, type RequestContext } from "./runtime/context.js";
