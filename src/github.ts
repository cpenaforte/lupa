import { context, getOctokit } from "@actions/github";
import type { InlineComment, ReviewPayload } from "./review.js";

export type Octokit = ReturnType<typeof getOctokit>;

/**
 * Token cannot write reviews (fork PR with a read-only token, or a 403 from the API).
 * `status` and `detail` (the API's own message) are kept so the caller can log why.
 * The caller degrades to summary + artifact and does not treat this as a failed run.
 */
export class ReadonlyTokenError extends Error {
  readonly status: number | undefined;
  readonly detail: string;

  constructor(message: string, status?: number, detail = "") {
    super(message);
    this.name = "ReadonlyTokenError";
    this.status = status;
    this.detail = detail;
  }
}

export class StaleHeadError extends Error {
  readonly analyzedSha: string;
  readonly liveSha: string;

  constructor(analyzedSha: string, liveSha: string) {
    super(`review post skipped: PR head moved (analyzed ${analyzedSha}, live ${liveSha})`);
    this.name = "StaleHeadError";
    this.analyzedSha = analyzedSha;
    this.liveSha = liveSha;
  }
}

export interface PostReviewResult {
  /** True when inline comments were folded into the review body after an off-diff 422. */
  degraded: boolean;
}

export interface PostReviewOptions {
  /**
   * Computed by the caller (fork PR + token type). When explicitly false, throws
   * ReadonlyTokenError before any POST is attempted.
   */
  canWrite?: boolean;
}

const OFF_DIFF = /could not be resolved|part of the diff|line.*(diff|resolve)/i;
// Commit-centric only: a bare "sha" would also match unrelated text such as "sha256:...".
const STALE_SHA = /commit[ _-]id|head[- ]commit|not a valid commit/i;

interface HttpLikeError {
  status?: unknown;
  message?: unknown;
  response?: { data?: unknown };
}

function statusOf(e: unknown): number | undefined {
  const s = (e as HttpLikeError | null)?.status;
  return typeof s === "number" ? s : undefined;
}

function messageOf(e: unknown): string {
  const m = (e as HttpLikeError | null)?.message;
  return typeof m === "string" ? m : "";
}

/** Text used only for classifying a 422. Never copied into thrown errors. */
function detailOf(e: unknown): string {
  const err = e as HttpLikeError | null;
  let data = "";
  try {
    data = JSON.stringify(err?.response?.data ?? "");
  } catch {
    data = "";
  }
  return `${messageOf(e)} ${data}`;
}

/** The API's own message for a 403, kept on ReadonlyTokenError for the caller's log. */
function apiMessageOf(e: unknown): string {
  const data = (e as HttpLikeError | null)?.response?.data as { message?: unknown } | undefined;
  if (typeof data?.message === "string" && data.message !== "") return data.message;
  return messageOf(e);
}

function positiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

function repoOf(): { owner: string; repo: string } {
  return context.repo;
}

/**
 * Repository size in KB (Octokit `repos.get` → `data.size`). Any error —
 * missing repo, no access, network failure — resolves to undefined so the
 * caller treats the size as unknown instead of failing the run.
 */
export async function getRepoSize(octokit: Octokit, owner: string, repo: string): Promise<number | undefined> {
  try {
    const r = await octokit.rest.repos.get({ owner, repo });
    const size = (r.data as { size?: unknown }).size;
    return typeof size === "number" ? size : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Off-diff fallback: inline comments move into the review body as a plain list, so the
 * retry posts a general-only review. Each item is `- path:line`, and every line of the
 * comment body follows indented by two spaces under it, so a multi-line body stays inside
 * its list item. CRLF and stray CR characters are normalized to LF first, so no `\r` leaks
 * into the body. Code fences are not special-cased: they are indented like any other line.
 * An empty or whitespace-only body emits the bare `- path:line` item with no continuation line.
 */
function foldComments(body: string, comments: InlineComment[]): string {
  if (comments.length === 0) return body;
  const items = comments.map((c) => {
    // Drop trailing whitespace-only lines so a body ending in "\r" or "\n" adds no bare "  " line.
    const text = c.body.replace(/\r\n?/g, "\n").replace(/(\n[ \t]*)+$/, "");
    const head = `- ${c.path}:${c.line}`;
    // A body that is empty or whitespace-only gets no continuation line at all.
    if (text.trim() === "") return head;
    return `${head}\n  ${text.replace(/\n/g, "\n  ")}`;
  });
  return `${body}\n\n**Findings not placed inline:**\n${items.join("\n")}`;
}

/**
 * Posts one consolidated review to `pulls/{pr}/reviews`.
 * - `canWrite: false` (caller-computed): throws ReadonlyTokenError before any POST.
 * - 422 stale commit_id: throws StaleHeadError with the analyzed and live SHAs; the caller
 *   skips the review for the stale head (never relabels or retries the POST).
 * - 422 line off-diff: inline comments are folded into the body and the POST is retried once.
 *   At most two POSTs in total (the initial attempt, then the off-diff retry).
 * - 403 (read-only token): throws ReadonlyTokenError with status and the API message.
 * - Any other failure throws a sanitized Error; the upstream message is never copied,
 *   so tokens or keys echoed by the API cannot leak into logs.
 */
export async function postReview(
  octokit: Octokit,
  pr: number,
  payload: ReviewPayload,
  opts?: PostReviewOptions,
): Promise<PostReviewResult> {
  if (opts?.canWrite === false) {
    throw new ReadonlyTokenError("review post skipped: token cannot write reviews (fork PR)");
  }
  const { owner, repo } = repoOf();
  const commitId = payload.commit_id;
  let body = payload.body;
  let comments = payload.comments;
  let degraded = false;

  for (;;) {
    try {
      await octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number: pr,
        commit_id: commitId,
        body,
        event: payload.event,
        comments,
      });
      return { degraded };
    } catch (e) {
      const status = statusOf(e);
      if (status === 403 && !/rate limit/i.test(detailOf(e))) {
        throw new ReadonlyTokenError(
          "review post refused: token cannot write reviews (HTTP 403)",
          403,
          apiMessageOf(e),
        );
      }
      if (status !== 422) {
        throw new Error(`review post failed${status === undefined ? "" : ` (HTTP ${status})`}`);
      }
      const detail = detailOf(e);
      if (STALE_SHA.test(detail)) {
        let head: string;
        try {
          const pull = await octokit.rest.pulls.get({ owner, repo, pull_number: pr });
          head = pull.data.head.sha;
        } catch (getErr) {
          const s = statusOf(getErr);
          throw new Error(`head sha re-resolve failed${s === undefined ? "" : ` (HTTP ${s})`}`);
        }
        throw new StaleHeadError(commitId, head);
      }
      if (!degraded && comments.length > 0 && OFF_DIFF.test(detail)) {
        body = foldComments(body, comments);
        comments = [];
        degraded = true;
        continue;
      }
      throw new Error("review post rejected (HTTP 422)");
    }
  }
}

/**
 * Fallback summary comment on the PR conversation. Only when the caller enabled it AND the
 * token has issues:write; otherwise throws and nothing is posted.
 */
export async function postIssueFallback(
  octokit: Octokit,
  opts: { enabled: boolean; issuesWrite: boolean; pr: number; body: string },
): Promise<void> {
  if (!opts.enabled) throw new Error("issue fallback disabled");
  if (!opts.issuesWrite) throw new Error("issue fallback requires issues: write");
  const { owner, repo } = repoOf();
  await octokit.rest.issues.createComment({ owner, repo, issue_number: opts.pr, body: opts.body });
}

/**
 * PR number for the event, or null when the event is not about a pull request
 * (e.g. a comment on a bare issue, or a dispatch without pr_number).
 */
export function resolvePrNumber(
  event: string,
  payload: {
    issue?: { number: number; pull_request?: unknown };
    pull_request?: { number: number };
    inputs?: { pr_number?: number };
  },
): number | null {
  switch (event) {
    case "pull_request":
    case "pull_request_review": {
      const n = payload.pull_request?.number;
      return positiveInt(n) ? n : null;
    }
    case "issue_comment": {
      const issue = payload.issue;
      if (issue === undefined || issue.pull_request === undefined) return null;
      return positiveInt(issue.number) ? issue.number : null;
    }
    case "workflow_dispatch": {
      const n = payload.inputs?.pr_number;
      return positiveInt(n) ? n : null;
    }
    default:
      return null;
  }
}

const TRIGGER_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const PR_ACTIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);

/**
 * Whether this event should run a review. workflow_run is always false: Fluxo B dispatches
 * on `github.event_name` in the workflow file, not through this function.
 */
export function shouldTrigger(
  event: string,
  payload: {
    action?: string;
    commentBody?: string;
    reviewBody?: string;
    authorAssociation?: string;
    issueHasPR?: boolean;
    prNumber?: number | null;
  },
): boolean {
  const trusted = TRIGGER_ASSOCIATIONS.has(payload.authorAssociation ?? "");
  switch (event) {
    case "pull_request":
      return PR_ACTIONS.has(payload.action ?? "");
    case "issue_comment":
      return (
        payload.action === "created" &&
        payload.issueHasPR === true &&
        (payload.commentBody ?? "").includes("/review") &&
        trusted
      );
    case "pull_request_review":
      return payload.action === "submitted" && (payload.reviewBody ?? "").trim() !== "" && trusted;
    case "workflow_dispatch":
      return positiveInt(payload.prNumber);
    default:
      return false;
  }
}
