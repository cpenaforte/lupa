// Compatibility facade. Algorithms and artifact I/O live in their owning modules.
export type { FileDiff, HunkLine, ParsedHunk, PrMeta } from "./domain/diff.js";
export { parseHunks, isLockfile, filterForPrompt, parseRename, PER_FILE_CAP, truncateDiff } from "./diff/patch.js";
export { writePrMeta, readPrMeta } from "./artifacts/review-store.js";
