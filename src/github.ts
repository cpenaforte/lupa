import { context, getOctokit } from "@actions/github";
import * as core from "@actions/core";
import type { InlineComment, ReviewPayload } from "./domain/review.js";
import { capBody, isTruncNoteLine, truncNoteFor } from "./review/limits.js";
import { DEFAULT_MAX_REVIEW_BODY_CHARS, parseReviewActor } from "./inputs.js";
import { memberRulesOf } from "./review/thread-identity.js";
import { escapeProse } from "./domain/text.js";

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
  /**
   * Review-body ceiling in Unicode code points for the off-diff fold re-cap.
   * Defaults to DEFAULT_MAX_REVIEW_BODY_CHARS (the max_review_body_chars input
   * default), so the re-cap always runs and existing no-opts callers keep
   * identical behavior on small bodies.
   */
  maxBodyChars?: number;
  /**
   * Blocking-set keys for the 422 off-diff fold. Folded items whose
   * index-aligned commentKeys entry is present AND outside this set render
   * `- path:line (non-blocking)`; anything else assumes blocking (no marker).
   */
  blocking?: ReadonlySet<string>;
  /** Index-aligned fold keys for the posted comments (null where rule absent). */
  commentKeys?: readonly (string | null)[];
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
export async function getRepoSize(
  octokit: Octokit,
  owner: string,
  repo: string,
  options?: { signal?: AbortSignal },
): Promise<number | undefined> {
  try {
    const r = await octokit.rest.repos.get({ owner, repo, ...(options?.signal ? { request: { signal: options.signal } } : {}) });
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
 * Items whose index-aligned key is present AND outside the blocking set gain a
 * ` (non-blocking)` suffix; a missing, null, or misaligned key (or no blocking
 * set at all) assumes blocking and renders no marker — fail-safe toward blocking.
 */
function foldComments(
  body: string,
  comments: InlineComment[],
  blocking?: ReadonlySet<string>,
  commentKeys?: readonly (string | null)[],
): string {
  if (comments.length === 0) return body;
  const items = comments.map((c, i) => {
    // Drop trailing whitespace-only lines so a body ending in "\r" or "\n" adds no bare "  " line.
    const text = c.body.replace(/\r\n?/g, "\n").replace(/(\n[ \t]*)+$/, "");
    const key = commentKeys?.[i] ?? null;
    const suffix = key !== null && blocking !== undefined && !blocking.has(key) ? " (non-blocking)" : "";
    const head = `- ${escapeProse(`${c.path}:${c.line}`)}${suffix}`;
    // A body that is empty or whitespace-only gets no continuation line at all.
    if (text.trim() === "") return head;
    return `${head}\n  ${text.replace(/\n/g, "\n  ")}`;
  });
  return `${body}\n\n**Findings not placed inline:**\n${items.join("\n")}`;
}

/**
 * Fold re-cap: the folded body must stay under the same char ceiling as the
 * publication cap. Exact algorithm: strip lines matching the trunc-note
 * template (remembering `strippedAny`); extract the `> Omitted:` count lines
 * from the body (removed, never duplicated) and pass them as capBody markers;
 * cut content fence-aware to `max − markers − note` (the note budget is always
 * reserved on the fold path, riding as a trailing marker); append markers,
 * then the fresh trunc-note IFF (`strippedAny` or the cut dropped content). A
 * stripped note is therefore always re-emitted; a clean fold (nothing dropped
 * anywhere) posts no spurious note.
 */
function recapFoldedBody(folded: string, maxChars: number): string {
  const note = truncNoteFor(maxChars);
  let strippedAny = false;
  const markers: string[] = [];
  const contentLines: string[] = [];
  for (const line of folded.split(/\r?\n/)) {
    if (isTruncNoteLine(line)) {
      strippedAny = true;
      continue;
    }
    if (line.startsWith("> Omitted:")) {
      if (!markers.includes(line)) markers.push(line);
      continue;
    }
    contentLines.push(line);
  }
  const content = contentLines.join("\n");
  const tailed = [...markers, note];
  const withNote = capBody(content, maxChars, tailed);
  if (strippedAny) return withNote;
  // The reserved cut is authoritative: keep its note only when it provably
  // dropped content, else fall back to the unreserved cap (which adds no note
  // when nothing is cut).
  const uncut = content === "" ? tailed.join("\n") : `${content}\n${tailed.join("\n")}`;
  if (withNote !== uncut) return withNote;
  return capBody(content, maxChars, markers);
}

/**
 * Posts one consolidated review to `pulls/{pr}/reviews`.
 * - `canWrite: false` (caller-computed): throws ReadonlyTokenError before any POST.
 * - 422 stale commit_id: throws StaleHeadError with the analyzed and live SHAs; the caller
 *   skips the review for the stale head (never relabels or retries the POST).
 * - 422 line off-diff: inline comments are folded into the body, the folded body is
 *   re-capped to `maxBodyChars` (omission counts preserved, exactly one trunc-note, last),
 *   and the POST is retried once.
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
        body = recapFoldedBody(
          foldComments(body, comments, opts?.blocking, opts?.commentKeys),
          opts?.maxBodyChars ?? DEFAULT_MAX_REVIEW_BODY_CHARS,
        );
        comments = [];
        degraded = true;
        continue;
      }
      throw new Error("review post rejected (HTTP 422)");
    }
  }
}

/**
 * One PR review thread, as needed for the wrongly-resolved re-check. `rule` is
 * taken from versioned raw identity metadata, or the legacy first-comment
 * heading (tolerating our own reopened marker). Unparseable bodies yield null
 * and never match. A null author (deleted account) never matches either.
 */
export interface ReviewThread {
  authorLogin: string | null;
  isResolved: boolean;
  path: string;
  line?: number | null;
  originalLine?: number | null;
  rule: string | null;
  /** Valid versioned raw member identities, when posted by a newer renderer. */
  rules?: readonly string[];
}

/** `formatBody` head shape, tolerating our own inline reopened marker. */
const THREAD_RULE_RE = /^\*\*(\w+)\*\* (?:\*\*reopened\*\* )?\[([^[\]]+)\]/;

function threadRuleOf(body: unknown): string | null {
  if (typeof body !== "string") return null;
  const m = THREAD_RULE_RE.exec(body);
  return m === null ? null : m[2]!;
}

interface ThreadNode {
  isResolved?: unknown;
  path?: unknown;
  line?: unknown;
  originalLine?: unknown;
  comments?: { nodes?: Array<{ author?: { login?: unknown } | null; body?: unknown }> };
}

function asThread(n: ThreadNode): ReviewThread {
  const first = n.comments?.nodes?.[0];
  const login = first?.author?.login;
  const line = typeof n.line === "number" ? n.line : null;
  const originalLine = typeof n.originalLine === "number" ? n.originalLine : null;
  const rules = memberRulesOf(first?.body);
  return {
    authorLogin: typeof login === "string" ? login : null,
    isResolved: n.isResolved === true,
    path: typeof n.path === "string" ? n.path : "",
    line,
    originalLine,
    // Modern headings are escaped display text; the versioned marker owns raw identity.
    // Legacy bodies retain their historical heading parser without decoding ambiguity.
    rule: rules?.[0] ?? threadRuleOf(first?.body),
    ...(rules === undefined ? {} : { rules }),
  };
}

export type ReviewThreadReadHealth = "ok" | "truncated" | "unavailable";

export interface ReviewThreadRead {
  threads: ReviewThread[];
  health: ReviewThreadReadHealth;
  reason?: "more-than-100-threads" | "malformed-response" | "graphql-error" | "no-token";
}

/**
 * Reads this PR's review threads (newest 100 — recent resolves are the relevant
 * ones) over GraphQL on the same client and reports the read's health: `truncated`
 * keeps the newest 100 when older pages exist; a malformed response or any thrown
 * error is `unavailable` with a fixed reason (never the remote error text). Never
 * throws and never logs: the caller decides how to account for incomplete context.
 */
export async function readReviewThreads(
  octokit: Octokit,
  owner: string,
  repo: string,
  pr: number,
): Promise<ReviewThreadRead> {
  try {
    const data = (await octokit.graphql(
      `query ($owner: String!, $repo: String!, $pr: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $pr) {
            reviewThreads(last: 100) {
              pageInfo { hasPreviousPage }
              nodes {
                isResolved
                path
                line
                originalLine
                comments(first: 1) { nodes { author { login } body } }
              }
            }
          }
        }
      }`,
      { owner, repo, pr },
    )) as { repository?: { pullRequest?: { reviewThreads?: { pageInfo?: { hasPreviousPage?: unknown }; nodes?: ThreadNode[] } } } };
    const threads = data.repository?.pullRequest?.reviewThreads;
    const pageInfo = threads?.pageInfo;
    if (
      threads === undefined ||
      !Array.isArray(threads.nodes) ||
      pageInfo === null ||
      typeof pageInfo !== "object" ||
      typeof pageInfo.hasPreviousPage !== "boolean"
    ) {
      return { threads: [], health: "unavailable", reason: "malformed-response" };
    }
    const mapped = threads.nodes.map(asThread);
    if (pageInfo.hasPreviousPage) {
      return { threads: mapped, health: "truncated", reason: "more-than-100-threads" };
    }
    return { threads: mapped, health: "ok" };
  } catch {
    return { threads: [], health: "unavailable", reason: "graphql-error" };
  }
}

export const THREAD_TRUNCATED_WARNING = "lupa: more than 100 review threads; re-checking the newest 100 only";
export const THREAD_UNAVAILABLE_WARNING = "lupa: review-thread re-read failed; gating on diff membership only";

/**
 * Compatibility wrapper over readReviewThreads: warns (lupa prefix) when the read
 * is truncated or unavailable and returns the available threads (fail-open: never
 * blocks on infra failure).
 */
export async function listReviewThreads(
  octokit: Octokit,
  owner: string,
  repo: string,
  pr: number,
): Promise<ReviewThread[]> {
  const read = await readReviewThreads(octokit, owner, repo, pr);
  if (read.health === "truncated") core.warning(THREAD_TRUNCATED_WARNING);
  else if (read.health === "unavailable") core.warning(THREAD_UNAVAILABLE_WARNING);
  return read.threads;
}

/**
 * Identity for the reopen match: authenticated login, then workflow-owned
 * configuration. Review prose never authenticates an actor.
 */
export async function fetchActor(
  octokit: Octokit,
  owner: string,
  repo: string,
  pr: number,
  options?: { trustedLogin?: string },
): Promise<string | undefined> {
  const trusted = parseReviewActor(options?.trustedLogin ?? "");
  try {
    const me = await octokit.rest.users.getAuthenticated();
    const login = (me.data as { login?: unknown }).login;
    if (typeof login === "string") {
      const authenticated = parseReviewActor(login);
      if (authenticated !== undefined) return authenticated;
    }
  } catch {
    // Installation tokens may not support the authenticated-user endpoint.
  }
  if (trusted !== undefined) return trusted;
  core.warning("lupa: could not determine the review actor; skipping the wrongly-resolved re-check");
  return undefined;
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
