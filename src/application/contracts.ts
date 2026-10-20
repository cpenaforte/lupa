import type { ActionInputs } from "../inputs.js";
import type { Finding } from "../domain/finding.js";
import type { ReviewPayload } from "../domain/review.js";
import type { ReviewThread } from "../github.js";
import type { ToolContext } from "../agent-tools.js";
import type { CatalogProtocol, ResolvedEndpoint } from "../providers.js";
import type { LlmResult } from "../llm/types.js";
import type { runScanners, ScannerResult } from "../scanners.js";
import type { callByStyle, callWithProbe, callByStyleAgent as runStyleAgent, callWithProbeAgent as runProbeAgent } from "../llm/router.js";

/** Everything the run needs from the environment. Built by readRunEnv() in production. */
export interface RunEnv {
  eventName: string;
  payload: Record<string, unknown>;
  inputs: ActionInputs;
  /** Checkout of the PR head (the template checks it out detached at HEAD_SHA). */
  workDir: string;
  /** Holds diff.patch (written by the template); receives pr-meta.json, findings.json, sarif, sbom. */
  artifactDir: string;
  baseSha: string;
  headSha: string;
  /** PR_REVIEWER_TOKEN_TYPE: "app" or "workflow-run" may write on a fork PR; "github-token" (and unset/unknown) never posts on a fork. */
  tokenType: "app" | "workflow-run" | "github-token";
  /** PR_REVIEWER_ISSUE_FALLBACK === "true". Only set when the template grants issues: write. */
  issueFallback: boolean;
  /** GITHUB_STEP_SUMMARY, when present. */
  summaryPath?: string;
}

export interface PrInfo {
  body: string;
  headSha: string;
  headRepo: string;
  headRef: string;
  isFork: boolean;
}

/** GitHub API boundary. Production wraps Octokit; tests inject fakes. */
export interface Gateway {
  getPr(pr: number): Promise<PrInfo>;
  /** Open PR numbers in the base repository whose head is `headRepo:headRef`. */
  findPrsByHead(headRepo: string, headRef: string): Promise<number[]>;
  getIssueBody(issue: number): Promise<string>;
  /** Repository size in KB, or undefined when unknown (any API error). */
  getRepoSize(owner: string, repo: string): Promise<number | undefined>;
  createReview(pr: number, payload: ReviewPayload, opts: { canWrite: boolean; maxBodyChars?: number; blocking?: ReadonlySet<string>; commentKeys?: readonly (string | null)[] }): Promise<void>;
  createIssueComment(pr: number, body: string, opts: { enabled: boolean; issuesWrite: boolean }): Promise<void>;
  /** This PR's review threads for the wrongly-resolved re-check (fail-open: empty on any error). */
  listReviewThreads(pr: number): Promise<ReviewThread[]>;
  /**
   * Login that posted our reviews (primary: authenticated user; fallback: newest
   * lupa-body review). Undefined when neither resolves — publishReview then
   * skips the reopen check. The pr is passed explicitly: publishReview owns a.pr
   * on both flows, with no context.issue dependency (undefined on workflow_run).
   */
  getActor(pr: number): Promise<string | undefined>;
}

/** Scanner, linter and LLM boundary. The privileged flow never invokes these. */
export interface Analysis {
  runScanners(o: Parameters<typeof runScanners>[0]): Promise<ScannerResult>;
  runL2(dir: string, changedFiles?: Set<string>): Promise<Finding[]>;
  ensureOllama(baseUrl: string, model: string, o: { timeoutSeconds?: number; apiKey?: string }): Promise<void>;
  checkModelListed(baseUrl: string, model: string, apiKey: string, protocol: CatalogProtocol): Promise<{ status: "listed" | "absent" | "unknown"; detail?: string }>;
  /** Single call to the endpoint's already-resolved style (explicit style / llm_path override). */
  callByStyle(ep: ResolvedEndpoint, messages: { system: string; user: string }, o: Parameters<typeof callByStyle>[2]): Promise<LlmResult>;
  /** Error-driven style routing (spec §9.5); the real seam logs the winning style. */
  callWithProbe(
    provider: string,
    model: string,
    baseUrl: string,
    apiKey: string,
    messages: { system: string; user: string },
    o: Parameters<typeof callWithProbe>[5],
  ): Promise<LlmResult>;
  /** Agent-mode single call against the endpoint's already-resolved style. */
  callByStyleAgent(
    ep: ResolvedEndpoint,
    conv: Parameters<typeof runStyleAgent>[1],
    o: Parameters<typeof runStyleAgent>[2],
    toolCtx: ToolContext,
  ): Promise<LlmResult>;
  /** Agent-mode error-driven style routing; the real seam logs the winning style. */
  callWithProbeAgent(
    provider: string,
    model: string,
    baseUrl: string,
    apiKey: string,
    conv: Parameters<typeof runProbeAgent>[4],
    o: Parameters<typeof runProbeAgent>[5],
    toolCtx: ToolContext,
  ): Promise<LlmResult>;
}

export interface Deps {
  gh: Gateway;
  analysis: Analysis;
}

export interface Outcome {
  posted: boolean;
  summaryWritten: boolean;
  exitCode: number;
  findingsFrom: "llm" | "fastpath";
  slowPathSkipped: boolean;
  issueBodyFetched?: number;
  staleSkipped?: boolean;
}

export interface EventFields {
  action?: string;
  comment?: { body?: string; author_association?: string };
  review?: { body?: string; author_association?: string };
  issue?: { number: number; pull_request?: unknown };
  pull_request?: { number: number };
  workflow_run?: {
    id?: number;
    head_sha?: string;
    head_branch?: string;
    head_repository?: { full_name?: string } | null;
  };
}
