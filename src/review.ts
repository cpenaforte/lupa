export type { InlineComment, ReviewPayload } from "./domain/review.js";
export type { GateDecision } from "./review/policy.js";
export { indexHunks, reopenedKey, normalizeBot, resolveReopened, partitionGate, evaluateRawGate, projectRenderMarks, eventFor, exitFor } from "./review/policy.js";
export type { FindingGroup } from "./review/grouping.js";
export { mergeDuplicates, groupFindings } from "./review/grouping.js";
export { formatBody, mapToComments, redactFindings, buildFallbackReport, buildBody } from "./review/render.js";
export { hasPatch, prioritizeFindings, omissionMarkerFor, truncNoteFor, isTruncNoteLine, capBody } from "./review/limits.js";
