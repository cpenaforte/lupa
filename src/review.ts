export type { InlineComment, ReviewPayload } from "./domain/review.js";
export { indexHunks, reopenedKey, normalizeBot, resolveReopened, partitionGate, eventFor, exitFor } from "./review/policy.js";
export { mergeDuplicates } from "./review/grouping.js";
export { formatBody, mapToComments, redactFindings, buildFallbackReport, buildBody } from "./review/render.js";
export { hasPatch, prioritizeFindings, omissionMarkerFor, truncNoteFor, isTruncNoteLine, capBody } from "./review/limits.js";
