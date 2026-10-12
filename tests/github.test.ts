import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as core from "@actions/core";
vi.mock("@actions/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@actions/core")>();
  return { ...actual, info: vi.fn(), warning: vi.fn(), error: vi.fn() };
});
import {
  fetchActor,
  listReviewThreads,
  ReadonlyTokenError,
  StaleHeadError,
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

/** First POST rejects 422 stale commit_id; the stale head is reported, not retried. */
async function postReviewStaleMock() {
  const f = fakeOctokit([httpError(422, STALE_MSG), "ok"]);
  const err = await postReview(f.octokit, 1, payload).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(StaleHeadError);
  expect(f.calls).toEqual(["post", "get"]);
  expect(f.createReview).toHaveBeenCalledTimes(1);
  return err as StaleHeadError;
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
  it("422 off-diff degrades to general and retries once; stale sha throws StaleHeadError", async () => {
    const calls: string[] = [];
    const r = await postReviewWithMock(calls);
    expect(calls.filter((c) => c === "post").length).toBe(2);
    expect(r.degraded).toBe(true);
    const s = await postReviewStaleMock();
    expect(s).toBeInstanceOf(StaleHeadError);
    expect(s.analyzedSha).toBe("sha-old");
    expect(s.liveSha).toBe("sha-new");
  });

  it("stale commit_id 422 throws StaleHeadError with both SHAs and makes no second POST", async () => {
    const f = fakeOctokit([httpError(422, STALE_MSG), "ok"], { headSha: "sha-new" });
    const err = await postReview(f.octokit, 1, payload).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StaleHeadError);
    const stale = err as StaleHeadError;
    expect(stale.analyzedSha).toBe("sha-old");
    expect(stale.liveSha).toBe("sha-new");
    expect(f.createReview).toHaveBeenCalledTimes(1);
    expect(f.calls).toEqual(["post", "get"]);
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

  it("stale then off-diff: stale throws StaleHeadError with a single POST, never degrading", async () => {
    const f = fakeOctokit([httpError(422, STALE_MSG), httpError(422, OFF_DIFF_MSG, OFF_DIFF_ERRORS), "ok"]);
    const err = await postReview(f.octokit, 1, payload).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StaleHeadError);
    expect(f.calls).toEqual(["post", "get"]);
    expect(f.createReview).toHaveBeenCalledTimes(1);
    expect((err as StaleHeadError).analyzedSha).toBe("sha-old");
    expect((err as StaleHeadError).liveSha).toBe("sha-new");
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

  it("plain success reports no degradation", async () => {
    const f = fakeOctokit(["ok"]);
    const r = await postReview(f.octokit, 1, payload);
    expect(r).toEqual({ degraded: false });
    expect(f.calls).toEqual(["post"]);
  });

  it("stale sha throws on the first stale 422 without a second POST", async () => {
    const f = fakeOctokit([httpError(422, STALE_MSG), httpError(422, STALE_MSG)]);
    const err = await postReview(f.octokit, 1, payload).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StaleHeadError);
    expect(f.createReview).toHaveBeenCalledTimes(1);
    expect(f.calls).toEqual(["post", "get"]);
  });

  it("a 422 whose message says 'Commit ID' (with a space) takes the stale path", async () => {
    const f = fakeOctokit([httpError(422, "Unprocessable Entity: Commit ID is out of date"), "ok"]);
    const err = await postReview(f.octokit, 1, payload).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StaleHeadError);
    expect(f.calls).toEqual(["post", "get"]);
    expect((err as StaleHeadError).liveSha).toBe("sha-new");
  });

  it("a 422 whose message says 'commit-id' (hyphen) takes the stale path", async () => {
    const f = fakeOctokit([httpError(422, "Unprocessable Entity: commit-id is out of date"), "ok"]);
    const err = await postReview(f.octokit, 1, payload).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StaleHeadError);
    expect(f.calls).toEqual(["post", "get"]);
    expect((err as StaleHeadError).liveSha).toBe("sha-new");
  });

  it("a single 422 matching both off-diff and stale patterns takes the stale path first", async () => {
    const both = "Unprocessable Entity: commit_id is not the head commit; Line could not be resolved";
    const f = fakeOctokit([httpError(422, both, OFF_DIFF_ERRORS), "ok"]);
    const err = await postReview(f.octokit, 1, payload).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StaleHeadError);
    expect(f.calls).toEqual(["post", "get"]);
    expect(f.createReview).toHaveBeenCalledTimes(1);
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

describe("postReview fold non-blocking markers", () => {
  const offDiff = () => httpError(422, OFF_DIFF_MSG, OFF_DIFF_ERRORS);
  const keyFor = (rule: string, path: string, line: number): string => `${rule}\0${path}\0${line}`;
  const blockingPayload: ReviewPayload = {
    commit_id: "sha-old",
    body: "summary",
    event: "COMMENT",
    comments: [
      { path: "a.ts", line: 4, side: "RIGHT", body: "**high** [rA] mA" },
      { path: "b.ts", line: 9, side: "RIGHT", body: "**warning** [rB] mB" },
    ],
  };

  it("marks only index-aligned keys outside the blocking set", async () => {
    const f = fakeOctokit([offDiff(), "ok"]);
    await postReview(f.octokit, 1, blockingPayload, {
      blocking: new Set([keyFor("rB", "b.ts", 9)]),
      commentKeys: [keyFor("rA", "a.ts", 4), keyFor("rB", "b.ts", 9)],
    });
    const body = String(f.reviewArgs[1]!.body);
    expect(body).toContain("- a.ts:4 (non-blocking)");
    expect(body).toContain("- b.ts:9\n ");
    expect(body).not.toContain("- b.ts:9 (non-blocking)");
  });

  it("treats a null key as blocking (no marker)", async () => {
    const f = fakeOctokit([offDiff(), "ok"]);
    await postReview(f.octokit, 1, blockingPayload, {
      blocking: new Set([keyFor("rB", "b.ts", 9)]),
      commentKeys: [null, keyFor("rB", "b.ts", 9)],
    });
    const body = String(f.reviewArgs[1]!.body);
    expect(body).not.toContain("- a.ts:4 (non-blocking)");
    expect(body).toContain("- a.ts:4\n ");
  });

  it("treats a length mismatch as blocking (no marker on the unkeyed tail)", async () => {
    const f = fakeOctokit([offDiff(), "ok"]);
    await postReview(f.octokit, 1, blockingPayload, {
      blocking: new Set<string>(),
      commentKeys: [keyFor("rA", "a.ts", 4)],
    });
    const body = String(f.reviewArgs[1]!.body);
    expect(body).toContain("- a.ts:4 (non-blocking)");
    expect(body).not.toContain("- b.ts:9 (non-blocking)");
  });

  it("emits no markers without blocking keys (hand-built comments stay marker-free)", async () => {
    const f = fakeOctokit([offDiff(), "ok"]);
    await postReview(f.octokit, 1, blockingPayload);
    const body = String(f.reviewArgs[1]!.body);
    expect(body).toContain("- a.ts:4\n ");
    expect(body).not.toContain("(non-blocking)");
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

describe("postReview fold re-cap", () => {
  const cps = (s: string): number => Array.from(s).length;
  const offDiff = () => httpError(422, OFF_DIFF_MSG, OFF_DIFF_ERRORS);
  const noteCount = (s: string): number =>
    s.match(/^> Note: review body truncated to the \d+-character limit\.$/gm)?.length ?? 0;

  it("re-caps a folded body: omission preserved, single trunc-note last, under cap", async () => {
    const omission = "> Omitted: 300 finding(s) omitted to fit the 200-finding publication limit.";
    const body = `${"H".repeat(300)}\n\n${omission}`;
    const testPayload: ReviewPayload = {
      commit_id: "sha-old",
      body,
      event: "COMMENT",
      comments: [
        { path: "a.ts", line: 4, side: "RIGHT", body: `**high** [r] ${"m".repeat(100)}` },
        { path: "b.ts", line: 9, side: "RIGHT", body: `**warning** [r] ${"n".repeat(100)}` },
      ],
    };
    const f = fakeOctokit([offDiff(), "ok"]);
    await postReview(f.octokit, 1, testPayload, { maxBodyChars: 500 });
    const retry = String(f.reviewArgs[1].body);
    expect(cps(retry)).toBeLessThanOrEqual(500);
    expect(retry.split("\n").filter((l) => l === omission)).toHaveLength(1);
    expect(noteCount(retry)).toBe(1);
    expect(retry.endsWith("> Note: review body truncated to the 500-character limit.")).toBe(true);
  });

  it("re-emits a stripped note even when the folded body fits afterwards", async () => {
    const stale = "> Note: review body truncated to the 99999-character limit.";
    const testPayload: ReviewPayload = {
      commit_id: "sha-old",
      body: `short summary\n${stale}`,
      event: "COMMENT",
      comments: [{ path: "a.ts", line: 4, side: "RIGHT", body: "tiny" }],
    };
    const f = fakeOctokit([offDiff(), "ok"]);
    await postReview(f.octokit, 1, testPayload, { maxBodyChars: 500 });
    const retry = String(f.reviewArgs[1].body);
    expect(cps(retry)).toBeLessThanOrEqual(500);
    expect(retry).not.toContain("99999");
    expect(noteCount(retry)).toBe(1);
    expect(retry.endsWith("> Note: review body truncated to the 500-character limit.")).toBe(true);
    expect(retry).toContain("- a.ts:4");
  });

  it("backs up before an indented folded fence when the cut lands inside it", async () => {
    const fenced = `**warning** [r] msg\n\n\`\`\`suggestion\n${"x".repeat(400)}\n\`\`\``;
    const testPayload: ReviewPayload = {
      commit_id: "sha-old",
      body: "summary",
      event: "COMMENT",
      comments: [{ path: "a.ts", line: 4, side: "RIGHT", body: fenced }],
    };
    const f = fakeOctokit([offDiff(), "ok"]);
    await postReview(f.octokit, 1, testPayload, { maxBodyChars: 300 });
    const retry = String(f.reviewArgs[1].body);
    expect(cps(retry)).toBeLessThanOrEqual(300);
    const fences = retry.split("\n").filter((l) => l.trimStart().startsWith("```")).length;
    expect(fences % 2).toBe(0);
    expect(retry).not.toContain("```suggestion");
    expect(retry.endsWith("> Note: review body truncated to the 300-character limit.")).toBe(true);
  });

  it("posts a clean fold with no spurious note when everything fits", async () => {
    const testPayload: ReviewPayload = {
      commit_id: "sha-old",
      body: "summary",
      event: "COMMENT",
      comments: [{ path: "a.ts", line: 4, side: "RIGHT", body: "tiny" }],
    };
    const f = fakeOctokit([offDiff(), "ok"]);
    await postReview(f.octokit, 1, testPayload, { maxBodyChars: 60000 });
    const retry = String(f.reviewArgs[1].body);
    expect(noteCount(retry)).toBe(0);
    expect(retry).toContain("- a.ts:4");
  });
});

describe("listReviewThreads", () => {
  const commentNode = (login: string | null, body: string) => ({ author: login === null ? null : { login }, body });
  const threadNode = (o: {
    isResolved?: boolean; path?: string; line?: number | null; originalLine?: number | null;
    login?: string | null; body?: string;
  } = {}) => ({
    isResolved: o.isResolved ?? true,
    path: o.path ?? "a.ts",
    line: o.line ?? 10,
    originalLine: o.originalLine ?? null,
    comments: { nodes: [commentNode(o.login === undefined ? "self" : o.login, o.body ?? "**high** [r] m")] },
  });
  const response = (nodes: unknown[], hasPreviousPage = false) => ({
    repository: { pullRequest: { reviewThreads: { pageInfo: { hasPreviousPage }, nodes } } },
  });
  const gqlOk = (nodes: unknown[], hasPreviousPage = false) => {
    const graphql = vi.fn(async () => response(nodes, hasPreviousPage));
    const octokit = { graphql } as unknown as Octokit;
    return { octokit, graphql };
  };

  beforeEach(() => {
    vi.mocked(core.warning).mockClear();
  });

  it("reads the newest 100 threads with the listed fields", async () => {
    const { octokit, graphql } = gqlOk([threadNode()]);
    const out = await listReviewThreads(octokit, "o", "r", 7);
    expect(graphql).toHaveBeenCalledTimes(1);
    const [query, vars] = graphql.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(query).toContain("last: 100");
    expect(query).toContain("isResolved");
    expect(query).toContain("originalLine");
    expect(vars).toEqual({ owner: "o", repo: "r", pr: 7 });
    expect(out).toEqual([{ authorLogin: "self", isResolved: true, path: "a.ts", line: 10, originalLine: null, rule: "r" }]);
  });

  it("warns with the lupa prefix and uses the 100 when hasPreviousPage", async () => {
    const { octokit } = gqlOk([threadNode()], true);
    const out = await listReviewThreads(octokit, "o", "r", 7);
    expect(out).toHaveLength(1);
    expect(vi.mocked(core.warning).mock.calls.some(([m]) => String(m).startsWith("lupa:"))).toBe(true);
  });

  it("returns empty with a warning on any fetch error", async () => {
    const graphql = vi.fn(async () => {
      throw new Error("boom");
    });
    const octokit = { graphql } as unknown as Octokit;
    await expect(listReviewThreads(octokit, "o", "r", 7)).resolves.toEqual([]);
    expect(vi.mocked(core.warning)).toHaveBeenCalled();
  });

  it("parses the rule from the first-comment body, tolerating our inline reopened marker", async () => {
    const { octokit } = gqlOk([
      threadNode({ body: "**high** **reopened** [r] m" }),
      threadNode({ path: "b.ts", body: "**warning** [a+b] m" }),
      threadNode({ path: "c.ts", body: "plain human reply" }),
      threadNode({ path: "d.ts", body: "**high** [broken rule] trailing" }),
    ]);
    const out = await listReviewThreads(octokit, "o", "r", 7);
    expect(out.map((t) => t.rule)).toEqual(["r", "a+b", null, "broken rule"]);
  });

  it("keeps a null author (never matches self)", async () => {
    const { octokit } = gqlOk([threadNode({ login: null })]);
    const out = await listReviewThreads(octokit, "o", "r", 7);
    expect(out[0]!.authorLogin).toBeNull();
  });
});

describe("fetchActor", () => {
  const review = (login: string, body: string) => ({ user: { login }, body });
  const LUPA = "lupa: 1 finding(s).";
  function actorOk(opts: {
    authed?: string | Error;
    pages?: Array<Array<{ user: { login: string }; body: string }>>;
    listError?: Error;
  } = {}) {
    const getAuthenticated = vi.fn(async () => {
      if (opts.authed instanceof Error) throw opts.authed;
      return { data: { login: opts.authed ?? "self" } };
    });
    const listReviews = vi.fn(async (params: { page?: number }) => {
      if (opts.listError !== undefined) throw opts.listError;
      const pages = opts.pages ?? [];
      return { data: pages[(params.page ?? 1) - 1] ?? [] };
    });
    const paginate = vi.fn(async (fn: (p: unknown) => Promise<{ data: unknown[] }>, params: Record<string, unknown>) => {
      const all: unknown[] = [];
      for (let page = 1; ; page++) {
        const r = await fn({ ...params, page });
        all.push(...r.data);
        if (r.data.length === 0) break;
      }
      return all;
    });
    const octokit = { rest: { users: { getAuthenticated }, pulls: { listReviews } }, paginate } as unknown as Octokit;
    return { octokit, getAuthenticated, listReviews, paginate };
  }

  beforeEach(() => {
    vi.mocked(core.warning).mockClear();
  });

  it("prefers the authenticated login", async () => {
    const { octokit, listReviews } = actorOk({ authed: "self" });
    await expect(fetchActor(octokit, "o", "r", 7)).resolves.toBe("self");
    expect(listReviews).not.toHaveBeenCalled();
  });

  it("falls back to the newest lupa-body review across pages (match on page two wins)", async () => {
    const { octokit, paginate } = actorOk({
      authed: new Error("403"),
      pages: [
        [review("human", "LGTM"), review("old-bot", LUPA)],
        [review("new-bot", LUPA)],
      ],
    });
    await expect(fetchActor(octokit, "o", "r", 7)).resolves.toBe("new-bot");
    const params = paginate.mock.calls[0]![1] as Record<string, unknown>;
    expect(params).toMatchObject({ owner: "o", repo: "r", pull_number: 7, per_page: 100 });
  });

  it("warns and returns undefined when both identity paths fail", async () => {
    const { octokit } = actorOk({ authed: new Error("403"), listError: new Error("boom") });
    await expect(fetchActor(octokit, "o", "r", 7)).resolves.toBeUndefined();
    expect(vi.mocked(core.warning).mock.calls.some(([m]) => String(m).startsWith("lupa:"))).toBe(true);
  });
});
