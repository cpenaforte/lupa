export interface InlineComment {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  /** Reserved for v2 multi-line ranges. Never set in v1 (see mapToComments). */
  start_line?: number;
  /** Reserved for v2 multi-line ranges. Never set in v1 (see mapToComments). */
  start_side?: "LEFT" | "RIGHT";
  body: string;
  /**
   * Finding rule, set by mapToComments for fold keys. INTERNAL: main.ts strips
   * it when building payload.comments, so posted payloads keep today's shape.
   * Absent (e.g. hand-built comments) means assume blocking in fold marking.
   */
  rule?: string;
}

export interface ReviewPayload {
  commit_id: string;
  body: string;
  event: "COMMENT" | "REQUEST_CHANGES";
  comments: InlineComment[];
}
