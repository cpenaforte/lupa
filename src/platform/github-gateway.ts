import { context, getOctokit } from "@actions/github";
import type { Gateway } from "../application/contracts.js";
import {
  fetchActor as fetchReviewActor, getRepoSize as fetchRepoSize, listReviewThreads as fetchReviewThreads,
  postIssueFallback, postReview,
} from "../github.js";

export function createGateway(token: string, options?: { trustedLogin?: string }): Gateway {
  // Lazy (M12): the client is built on first use, so a non-triggering run never needs a token.
  let client: ReturnType<typeof getOctokit> | undefined;
  const octokit = (): ReturnType<typeof getOctokit> => (client ??= getOctokit(token));
  return {
    async getPr(pr) {
      const { owner, repo } = context.repo;
      const r = await octokit().rest.pulls.get({ owner, repo, pull_number: pr });
      const headRepo = r.data.head.repo?.full_name ?? "";
      return {
        body: r.data.body ?? "",
        headSha: r.data.head.sha,
        headRepo,
        headRef: r.data.head.ref,
        isFork: headRepo !== r.data.base.repo.full_name,
      };
    },
    async findPrsByHead(headRepo, headRef) {
      const { owner, repo } = context.repo;
      const headOwner = headRepo.split("/")[0];
      const prs = await octokit().paginate(octokit().rest.pulls.list, {
        owner,
        repo,
        state: "open",
        head: `${headOwner}:${headRef}`,
        per_page: 100,
      });
      return prs
        .filter(
          (p) =>
            p.head.repo?.full_name === headRepo && p.head.ref === headRef && p.base.repo.full_name === `${owner}/${repo}`,
        )
        .map((p) => p.number);
    },
    async getIssueBody(issue) {
      const { owner, repo } = context.repo;
      const r = await octokit().rest.issues.get({ owner, repo, issue_number: issue });
      return r.data.body ?? "";
    },
    getRepoSize: (owner, repo) => fetchRepoSize(octokit(), owner, repo),
    listReviewThreads: async (pr) => {
      // No token (dry-run without one): skip silently — the expected path.
      if (token === "") return [];
      const { owner, repo } = context.repo;
      return fetchReviewThreads(octokit(), owner, repo, pr);
    },
    getActor: async (pr) => {
      if (token === "") return undefined;
      const { owner, repo } = context.repo;
      return fetchReviewActor(octokit(), owner, repo, pr, options);
    },
    createReview: (pr, payload, opts) =>
      postReview(octokit(), pr, payload, { canWrite: opts.canWrite, maxBodyChars: opts.maxBodyChars, blocking: opts.blocking, commentKeys: opts.commentKeys }).then(() => undefined),
    createIssueComment: (pr, body, opts) => postIssueFallback(octokit(), { pr, body, ...opts }),
  };
}
