import type { DedupVerdicts } from "../llm.js";

export interface FileDiff {
  file: string;
  hunks: string;
  truncated: boolean;
  /** Decided by git (binary diff). Never guess from extension. */
  binary?: boolean;
  /** Set from the `deleted file mode` header: the file was deleted, so it introduces nothing. */
  deleted?: boolean;
  /** Bytes on disk (stat). The large-file rule uses this, never hunks.length. */
  size?: number;
}

/** One commentable diff line. LEFT = old-file line number (deletion); RIGHT = new-file line number. */
export interface HunkLine {
  side: "LEFT" | "RIGHT";
  line: number;
  kind: "add" | "del" | "ctx";
}

/** One unified-diff hunk of a file, with the commentable lines it exposes. */
export interface ParsedHunk {
  file: string;
  lines: HunkLine[];
}

export interface PrMeta {
  pr_number: number;
  head_sha: string;
  base_sha: string;
  head_repo_full_name: string;
  is_fork: boolean;
  /** Dedup verdicts from the Flow A slow path. A missing key means no judge ran (silent no-merge). */
  verdicts?: DedupVerdicts;
}
