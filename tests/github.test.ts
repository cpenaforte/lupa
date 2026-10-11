import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ReadonlyTokenError,
  getRepoSize,
  postIssueFallback,
  postReview,
  resolvePrNumber,
  shouldTrigger,
  type Octokit,
} from "../src/github.js";
import type { ReviewPayload } from "../src/review.js";

const payload: ReviewPayload = {
  commit_id: "sha-old",
  body: "summary",
  event: "COMMENT",
  comments: [{ path: "a.ts", line: 4, side: "RIGHT", body: "**high** [r] m" }],
};

const OFF_DIFF_MSG = "Unprocessable Entity";
const OFF_DIFF_ERRORS = [{ message: "Line could not be resolved" }];
const STALE_MSG = "Unprocessable Entity: commit_id is not the head commit";

beforeEach(() => {
  process.env.GITHUB_REPOSITORY = "owner/repo";
});
afterEach(() => {
  delete process.env.GITHUB_REPOSITORY;
});

function httpError(status: number, message: string, errors?: unknown[]): Error {
  return Object.assign(new Error(message), { status, response: { data: { message, errors } } });
}

/**
 * Fake octokit. createReview runs the scripted outcomes in order ("ok" or an Error).
 * pulls.get resolves to headSha, or rejects with getError when given.
 */
function fakeOctokit(outcomes: Array<"ok" | Error>, opts: { headSha?: string; getError?: Error } = {}) {
  const calls: string[] = [];
  const reviewArgs: Array<Record<string, unknown>> = [];
  const createReview = vi.fn(async (args: Record<string, unknown>) => {
    reviewArgs.push(args);
    calls.push("post");
    const next = outcomes.shift();
    if (next === undefined || next === "ok") return { data: {} };
    throw next;
  });
  const get = vi.fn(async () => {
    calls.push("get");
    if (opts.getError !== undefined) throw opts.getError;
    return { data: { head: { sha: opts.headSha ?? "sha-new" } } };
  });
  const createComment = vi.fn(async () => {
    calls.push("comment");
    return { data: {} };
  });
  const octokit = { rest: { pulls: { createReview, get }, issues: { createComment } } } as unknown as Octokit;
  return { octokit, calls, reviewArgs, createReview, get, createComment };
}

/** First POST rejects 422 line-off-diff, second succeeds. */
async function postReviewWithMock(calls: string[]) {
  const f = fakeOctokit([httpError(422, OFF_DIFF_MSG, OFF_DIFF_ERRORS), "ok"]);
  const r = await postReview(f.octokit, 1, payload);
  calls.push(...f.calls);
  return r;
}

/** First POST rejects 422 stale commit_id; head_sha is re-resolved and the retry succeeds. */
async function postReviewStaleMock() {
  const f = fakeOctokit([httpError(422, STALE_MSG), "ok"]);
  const r = await postReview(f.octokit, 1, payload);
  expect(f.calls).toEqual(["post", "get", "post"]);
  expect(f.reviewArgs[1].commit_id).toBe("sha-new");
  return r;
}

/** A 500 that carries the key in its message; postReview must not leak it. */
async function postReviewFailing(key: string) {
  const f = fakeOctokit([httpError(500, `server exploded with ${key}`)]);
  return postReview(f.octokit, 1, payload).catch((e: unknown) => ({ error: String(e) }));
}

/** Network throw carrying the key. */
async function postReviewThrowing(key: string) {
  const f = fakeOctokit([new Error(`socket hang up ${key}`)]);
  return postReview(f.octokit, 1, payload);
}

describe("resolvePrNumber", () => {
  it("issue without pull_request resolves null; review uses top-level pull_request; dispatch via inputs", () => {
    expect(resolvePrNumber("pull_request", { pull_request: { number: 7 } })).toBe(7);
    expect(resolvePrNumber("issue_comment", { issue: { number: 5 } })).toBeNull();
    expect(resolvePrNumber("issue_comment", { issue: { number: 5, pull_request: {} } })).toBe(5);
    expect(resolvePrNumber("pull_request_review", { pull_request: { number: 9 }, inputs: {} })).toBe(9);
    expect(resolvePrNumber("workflow_dispatch", { inputs: { pr_number: 11 } })).toBe(11);
    expect(resolvePrNumber("workflow_dispatch", { inputs: {} })).toBeNull();
  });
});

describe("shouldTrigger", () => {
  it("gates actions and events", () => {
    expect(shouldTrigger("pull_request", { action: "opened" })).toBe(true);
    expect(shouldTrigger("pull_request", { action: "synchronize" })).toBe(true);
    expect(shouldTrigger("pull_request", { action: "reopened" })).toBe(true);
    expect(shouldTrigger("pull_request", { action: "ready_for_review" })).toBe(true);
    expect(shouldTrigger("pull_request", { action: "labeled" })).toBe(false);
    expect(
      shouldTrigger("issue_comment", { commentBody: "LGTM", authorAssociation: "MEMBER", issueHasPR: true }),
    ).toBe(false);
    expect(
      shouldTrigger("issue_comment", {
        commentBody: "/review please",
        authorAssociation: "CONTRIBUTOR",
        issueHasPR: true,
      }),
    ).toBe(false);
    expect(
      shouldTrigger("issue_comment", { commentBody: "/review", authorAssociation: "OWNER", issueHasPR: false }),
    ).toBe(false);
    expect(
      shouldTrigger("issue_comment", {
        action: "created",
        commentBody: "/review",
        authorAssociation: "OWNER",
        issueHasPR: true,
      }),
    ).toBe(true);
    expect(
      shouldTrigger("issue_comment", {
        action: "edited",
        commentBody: "/review",
        authorAssociation: "OWNER",
        issueHasPR: true,
      }),
    ).toBe(false);
    expect(shouldTrigger("workflow_dispatch", { prNumber: null })).toBe(false);
    expect(shouldTrigger("workflow_dispatch", { prNumber: 3 })).toBe(true);
    expect(shouldTrigger("workflow_run", {})).toBe(false);
  });

  it("dispatch prNumber uses the same positive-integer rule as resolvePrNumber", () => {
    expect(shouldTrigger("workflow_dispatch", { prNumber: 0 })).toBe(false);
    expect(shouldTrigger("workflow_dispatch", { prNumber: -1 })).toBe(false);
    expect(shouldTrigger("workflow_dispatch", { prNumber: 1.5 })).toBe(false);
    expect(shouldTrigger("workflow_dispatch", { prNumber: 1 })).toBe(true);
  });

  it("covers review association too", () => {
    expect(
      shouldTrigger("pull_request_review", { action: "submitted", reviewBody: "LGTM", authorAssociation: "MEMBER" }),
    ).toBe(true);
    expect(
      shouldTrigger("pull_request_review", { action: "edited", reviewBody: "LGTM", authorAssociation: "MEMBER" }),
    ).toBe(false);
    expect(
      shouldTrigger("pull_request_review", {
        action: "submitted",
        reviewBody: "LGTM",
        authorAssociation: "CONTRIBUTOR",
      }),
    ).toBe(false);
    expect(
      shouldTrigger("pull_request_review", { action: "submitted", reviewBody: "", authorAssociation: "MEMBER" }),
    ).toBe(false);
    // Whitespace-only review body counts as empty (deliberate).
    expect(
      shouldTrigger("pull_request_review", { action: "submitted", reviewBody: "  \n ", authorAssociation: "MEMBER" }),
    ).toBe(false);
  });
});

describe("postReview", () => {
  it("422 off-diff degrades to general and retries once; stale sha re-resolves", async () => {
    const calls: string[] = [];
    const r = await postReviewWithMock(calls);
    expect(calls.filter((c) => c === "post").length).toBe(2);
    expect(r.degraded).toBe(true);
    const s = await postReviewStaleMock();
    expect(s.retriedWithNewSha).toBe(true);
  });

  it("off-diff retry posts with no inline comments and the comments folded into the body", async () => {
    const f = fakeOctokit([httpError(422, OFF_DIFF_MSG, OFF_DIFF_ERRORS), "ok"]);
    await postReview(f.octokit, 7, payload);
    const retry = f.reviewArgs[1];
    expect(retry.comments).toEqual([]);
    expect(String(retry.body)).toContain("a.ts:4");
    expect(String(retry.body)).toContain("**high** [r] m");
    expect(retry.pull_number).toBe(7);
    expect(retry.owner).toBe("owner");
    expect(retry.repo).toBe("repo");
  });

  it("folds a multi-line comment body, indenting its continuation lines under the list item", async () => {
    const multi: ReviewPayload = {
      ...payload,
      comments: [{ path: "b.ts", line: 9, side: "RIGHT", body: "**medium** [r] first\nsecond line\nthird line" }],
    };
    const f = fakeOctokit([httpError(422, OFF_DIFF_MSG, OFF_DIFF_ERRORS), "ok"]);
    await postReview(f.octokit, 1, multi);
    const body = String(f.reviewArgs[1].body);
    expect(body).toContain("- b.ts:9\n  **medium** [r] first\n  second line\n  third line");
  });

  it("CRLF and stray CR in a comment body are normalized before the fold indent", async () => {
    const crlf: ReviewPayload = {
      ...payload,
      comments: [{ path: "c.ts", line: 2, side: "RIGHT", body: "first\r\nsecond\rthird" }],
    };
    const f = fakeOctokit([httpError(422, OFF_DIFF_MSG, OFF_DIFF_ERRORS), "ok"]);
    await postReview(f.octokit, 1, crlf);
    const body = String(f.reviewArgs[1].body);
    expect(body).toContain("- c.ts:2\n  first\n  second\n  third");
    expect(body).not.toContain("\r");
  });

  it("a comment body ending in CR adds no trailing whitespace-only line to the fold", async () => {
    const trailing: ReviewPayload = {
      ...payload,
      comments: [{ path: "d.ts", line: 5, side: "RIGHT", body: "only line\r" }],
    };
    const f = fakeOctokit([httpError(422, OFF_DIFF_MSG, OFF_DIFF_ERRORS), "ok"]);
    await postReview(f.octokit, 1, trailing);
    const body = String(f.reviewArgs[1].body);
    expect(body.endsWith("- d.ts:5\n  only line")).toBe(true);
    expect(body).not.toMatch(/\n[ \t]+$/);
  });

  it("an empty or all-newline comment body folds to the item line only, with no whitespace line", async () => {
    for (const body of ["", "\n", "\r\n\r\n"]) {
      const empty: ReviewPayload = {
        ...payload,
        comments: [{ path: "e.ts", line: 6, side: "RIGHT", body }],
      };
      const f = fakeOctokit([httpError(422, OFF_DIFF_MSG, OFF_DIFF_ERRORS), "ok"]);
      await postReview(f.octokit, 1, empty);
      const folded = String(f.reviewArgs[1].body);
      expect(folded.endsWith("- e.ts:6")).toBe(true);
      expect(folded).not.toMatch(/\n[ \t]*$/);
    }
  });

  it("stale then off-diff: three POSTs, ends as a general-only COMMENT with empty comments", async () => {
    const f = fakeOctokit([httpError(422, STALE_MSG), httpError(422, OFF_DIFF_MSG, OFF_DIFF_ERRORS), "ok"]);
    const r = await postReview(f.octokit, 1, payload);
    expect(f.calls).toEqual(["post", "get", "post", "post"]);
    expect(f.createReview).toHaveBeenCalledTimes(3);
    const last = f.reviewArgs[2];
    expect(last.event).toBe("COMMENT");
    expect(last.comments).toEqual([]);
    expect(last.commit_id).toBe("sha-new");
    expect(r).toEqual({ degraded: true, retriedWithNewSha: true });
  });

  it("degrades at most once: a second off-diff 422 throws", async () => {
    const f = fakeOctokit([
      httpError(422, OFF_DIFF_MSG, OFF_DIFF_ERRORS),
      httpError(422, OFF_DIFF_MSG, OFF_DIFF_ERRORS),
    ]);
    await expect(postReview(f.octokit, 1, payload)).rejects.toThrow();
    expect(f.createReview).toHaveBeenCalledTimes(2);
  });

  it("does not degrade when there are no inline comments", async () => {
    const f = fakeOctokit([httpError(422, OFF_DIFF_MSG, OFF_DIFF_ERRORS)]);
    await expect(postReview(f.octokit, 1, { ...payload, comments: [] })).rejects.toThrow();
    expect(f.createReview).toHaveBeenCalledTimes(1);
  });

  it("plain success reports no degradation and no re-resolve", async () => {
    const f = fakeOctokit(["ok"]);
    const r = await postReview(f.octokit, 1, payload);
    expect(r).toEqual({ degraded: false, retriedWithNewSha: false });
    expect(f.calls).toEqual(["post"]);
  });

  it("stale sha retries once only", async () => {
    const f = fakeOctokit([httpError(422, STALE_MSG), httpError(422, STALE_MSG)]);
    await expect(postReview(f.octokit, 1, payload)).rejects.toThrow();
    expect(f.createReview).toHaveBeenCalledTimes(2);
    expect(f.calls).toEqual(["post", "get", "post"]);
  });

  it("a 422 whose message says 'Commit ID' (with a space) takes the stale path", async () => {
    const f = fakeOctokit([httpError(422, "Unprocessable Entity: Commit ID is out of date"), "ok"]);
    const r = await postReview(f.octokit, 1, payload);
    expect(f.calls).toEqual(["post", "get", "post"]);
    expect(r.retriedWithNewSha).toBe(true);
  });

  it("a 422 whose message says 'commit-id' (hyphen) takes the stale path", async () => {
    const f = fakeOctokit([httpError(422, "Unprocessable Entity: commit-id is out of date"), "ok"]);
    const r = await postReview(f.octokit, 1, payload);
    expect(f.calls).toEqual(["post", "get", "post"]);
    expect(r.retriedWithNewSha).toBe(true);
  });

  it("a single 422 matching both off-diff and stale patterns takes the stale path first", async () => {
    const both = "Unprocessable Entity: commit_id is not the head commit; Line could not be resolved";
    const f = fakeOctokit([httpError(422, both, OFF_DIFF_ERRORS), "ok"]);
    const r = await postReview(f.octokit, 1, payload);
    expect(f.calls).toEqual(["post", "get", "post"]);
    expect(f.reviewArgs[1].comments).toEqual(payload.comments);
    expect(r).toEqual({ degraded: false, retriedWithNewSha: true });
  });

  it("a 422 mentioning sha256 does not take the stale path", async () => {
    const f = fakeOctokit([httpError(422, "Unprocessable Entity: sha256:abc is invalid")]);
    await expect(postReview(f.octokit, 1, payload)).rejects.toThrow();
    expect(f.get).not.toHaveBeenCalled();
    expect(f.createReview).toHaveBeenCalledTimes(1);
  });

  it("pulls.get rejection on the stale path throws a sanitized error and does not retry", async () => {
    const f = fakeOctokit([httpError(422, STALE_MSG)], { getError: new Error("boom sk-secret-abc") });
    const err = await postReview(f.octokit, 1, payload).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).not.toContain("sk-secret-abc");
    expect(f.createReview).toHaveBeenCalledTimes(1);
  });

  it("a 422 whose message carries the key does not leak it into the thrown error", async () => {
    const f = fakeOctokit([httpError(422, "Unprocessable Entity: bad token sk-secret-abc")]);
    const err = await postReview(f.octokit, 1, payload).catch((e: unknown) => e);
    expect(String(err)).not.toContain("sk-secret-abc");
  });

  it("canWrite false throws ReadonlyTokenError before any POST", async () => {
    const f = fakeOctokit(["ok"]);
    const err = await postReview(f.octokit, 1, payload, { canWrite: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReadonlyTokenError);
    expect(f.createReview).not.toHaveBeenCalled();
    expect(f.calls).toEqual([]);
  });

  it("canWrite true or omitted posts normally", async () => {
    const a = fakeOctokit(["ok"]);
    await postReview(a.octokit, 1, payload, { canWrite: true });
    expect(a.createReview).toHaveBeenCalledTimes(1);
    const b = fakeOctokit(["ok"]);
    await postReview(b.octokit, 1, payload);
    expect(b.createReview).toHaveBeenCalledTimes(1);
  });

  it("403 throws ReadonlyTokenError with status and the API message as detail", async () => {
    const f = fakeOctokit([httpError(403, "Resource not accessible by integration")]);
    const err = await postReview(f.octokit, 1, payload).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReadonlyTokenError);
    expect(err).toBeInstanceOf(Error);
    const ro = err as ReadonlyTokenError;
    expect(ro.name).toBe("ReadonlyTokenError");
    expect(ro.status).toBe(403);
    expect(ro.detail).toContain("Resource not accessible by integration");
  });

  it("never logs api key in result or throw", async () => {
    const r = await postReviewFailing("sk-secret-abc");
    expect(JSON.stringify(r)).not.toContain("sk-secret-abc");
    const err = await postReviewThrowing("sk-secret-abc").catch((e) => String(e));
    expect(err).not.toContain("sk-secret-abc");
  });
});

describe("getRepoSize", () => {
  it("getRepoSize returns the Octokit size in KB and undefined on error", async () => {
    const ok = { rest: { repos: { get: async () => ({ data: { size: 4321 } }) } } } as unknown as Octokit;
    await expect(getRepoSize(ok, "o", "r")).resolves.toBe(4321);
    const failing = {
      rest: {
        repos: {
          get: async () => {
            throw httpError(404, "Not Found");
          },
        },
      },
    } as unknown as Octokit;
    await expect(getRepoSize(failing, "o", "r")).resolves.toBeUndefined();
  });
});

describe("postIssueFallback", () => {
  it("posts a comment when enabled and issues:write", async () => {
    const f = fakeOctokit([]);
    await postIssueFallback(f.octokit, { enabled: true, issuesWrite: true, pr: 4, body: "hi" });
    expect(f.createComment).toHaveBeenCalledTimes(1);
  });

  it("throws when disabled", async () => {
    const f = fakeOctokit([]);
    await expect(
      postIssueFallback(f.octokit, { enabled: false, issuesWrite: true, pr: 4, body: "hi" }),
    ).rejects.toThrow();
    expect(f.createComment).not.toHaveBeenCalled();
  });

  it("throws without issues:write", async () => {
    const f = fakeOctokit([]);
    await expect(
      postIssueFallback(f.octokit, { enabled: true, issuesWrite: false, pr: 4, body: "hi" }),
    ).rejects.toThrow();
    expect(f.createComment).not.toHaveBeenCalled();
  });
});
