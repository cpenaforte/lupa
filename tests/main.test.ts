import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import * as core from "@actions/core";
import { afterEach, describe, expect, it, vi } from "vitest";

// Capture action logs for assertions without printing expected fixture messages during tests.
vi.mock("@actions/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@actions/core")>();
  return { ...actual, info: vi.fn(), warning: vi.fn(), error: vi.fn() };
});
import { budgetPrompt, cleanEnvForExec, main, readFindings, readRunEnv, run, sanitizeFinding, toSarif, unquoteGitPath, type Deps, type Gateway, type PrInfo, type RunEnv } from "../src/main.js";
import { buildMessages, ISSUE_TRUNCATION_MARKER, neutralise } from "../src/prompt.js";
import { readPrMeta } from "../src/diff.js";
import type { DedupVerdicts } from "../src/llm.js";
import type { ActionInputs, LlmApiStyle, LlmProvider } from "../src/inputs.js";
import {
  DEFAULT_MAX_ARTIFACT_BYTES,
  DEFAULT_MAX_FINDINGS,
  DEFAULT_MAX_INLINE_COMMENTS,
  DEFAULT_MAX_REVIEW_BODY_CHARS,
} from "../src/inputs.js";
import { callWithProbe } from "../src/llm.js";
import { ReadonlyTokenError, StaleHeadError } from "../src/github.js";
import { buildFallbackReport, redactFindings, type ReviewPayload } from "../src/review.js";
import { TOOL_DEFS, executeTool } from "../src/agent-tools.js";
import type { ToolContext } from "../src/agent-tools.js";
import type { Finding } from "../src/fastpath.js";

const SHA_HEAD = "a".repeat(40);
const SHA_OTHER = "c".repeat(40);
const SHA_BASE = "b".repeat(40);

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 const x = 1;
+const y = 2;
 export {};
`;

const BINARY = `diff --git a/img.png b/img.png
index 111..222 100644
Binary files a/img.png and b/img.png differ
`;

/** Git's default quoting of a non-ASCII name (core.quotePath=true): UTF-8 bytes as octal escapes. */
const QUOTED_BINARY = [
  'diff --git "a/caf\\303\\251.bin" "b/caf\\303\\251.bin"',
  'Binary files "a/caf\\303\\251.bin" and "b/caf\\303\\251.bin" differ',
  "",
].join("\n");

const LLM_FINDING: Finding = {
  severity: "warning",
  file: "src/a.ts",
  line: 2,
  rule: "logic",
  message: "llm message",
};

const TRUNC = "…[truncated]";

const created: string[] = [];

afterEach(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function scratch(): string {
  mkdirSync("/tmp/opencode", { recursive: true });
  const d = mkdtempSync("/tmp/opencode/pr-main-");
  created.push(d);
  return d;
}

interface Rec {
  reviews: ReviewPayload[];
  reviewAttempts: number;
  issueComments: string[];
  getPrCalls: number;
  issueBodyFetched?: number;
  llmCalled: number;
  /** Which seam served the slow-path LLM call (spec §9.5 wiring). */
  llmVia?: "probe" | "style";
  ollamaCalled: number;
  modelProtocol?: "openai" | "anthropic" | "google";
  scanEnv?: NodeJS.ProcessEnv;
  l2Env?: NodeJS.ProcessEnv;
  l2Changed?: Set<string>;
  agentCalled: number;
  /** Which agent seam served the slow-path LLM call. */
  agentVia?: "probe" | "style";
  agentTools?: unknown;
  agentMaxTurns?: number;
  agentMaxSeconds?: number;
  agentConv?: unknown;
  agentToolCtx?: ToolContext;
  toolOutput?: string;
  toolError?: boolean;
  /** findings.json payload observed by the slow-path seam: the early (fast-only) write, before the merged overwrite. */
  earlyFindingsRaw?: string;
  /** Options observed by the createReview fake (F15 asserts maxBodyChars forwarding). */
  reviewOpts?: { canWrite: boolean; maxBodyChars?: number };
  /** Blocking set and post-slice comment keys observed by the createReview fake (Q02 threading pin). */
  reviewBlocking?: ReadonlySet<string>;
  reviewCommentKeys?: readonly (string | null)[];
  repoSizeCalls: Array<[string, string]>;
  /** Prompt messages observed by the slow-path seam (Task 58 asserts on these). */
  prompts?: { system: string; user: string };
}

function newRec(): Rec {
  return { reviews: [], reviewAttempts: 0, issueComments: [], getPrCalls: 0, llmCalled: 0, ollamaCalled: 0, agentCalled: 0, repoSizeCalls: [] };
}

interface GwOpts {
  prsByHead?: number[];
  write403?: boolean;
  staleDuringPost?: boolean;
  issue403?: boolean;
  body?: string;
  /** Issue body returned by the getIssueBody fake (default "issue text"). */
  issueBody?: string;
  /** Size in KB reported by the getRepoSize fake (default 1024). */
  repoSizeKb?: number;
  /** Second and later getPr calls report a moved head. */
  headMoves?: boolean;
  /** getPr throws once the call count exceeds this number. */
  failGetPrAfter?: number;
  info?: Partial<PrInfo>;
}

function gatewayFor(rec: Rec, o: GwOpts): Gateway {
  const base: PrInfo = {
    body: o.body ?? "",
    headSha: SHA_HEAD,
    headRepo: "o/r",
    headRef: "feature",
    isFork: false,
    ...o.info,
  };
  return {
    findPrsByHead: async () => o.prsByHead ?? [7],
    getPr: async () => {
      rec.getPrCalls += 1;
      if (o.failGetPrAfter !== undefined && rec.getPrCalls > o.failGetPrAfter) throw new Error("getPr boom");
      if (o.headMoves && rec.getPrCalls > 1) return { ...base, headSha: SHA_OTHER };
      return base;
    },
    getIssueBody: async (n) => {
      rec.issueBodyFetched = n;
      return o.issueBody ?? "issue text";
    },
    getRepoSize: async (owner, repo) => {
      rec.repoSizeCalls.push([owner, repo]);
      return o.repoSizeKb ?? 1024;
    },
    createReview: async (_pr, payload, opts) => {
      rec.reviewOpts = { canWrite: opts.canWrite, ...(opts.maxBodyChars !== undefined ? { maxBodyChars: opts.maxBodyChars } : {}) };
      rec.reviewBlocking = opts.blocking;
      rec.reviewCommentKeys = opts.commentKeys;
      rec.reviewAttempts += 1;
      if (o.write403) {
        throw new ReadonlyTokenError("review post refused", 403, "Resource not accessible by integration");
      }
      if (o.staleDuringPost) {
        throw new StaleHeadError(SHA_HEAD, SHA_OTHER);
      }
      rec.reviews.push(payload);
    },
    createIssueComment: async (_pr, body) => {
      if (o.issue403) throw new Error("issue comment refused (HTTP 403)");
      rec.issueComments.push(body);
    },
  };
}

function inputsFor(o: MockOpts): ActionInputs {
  return {
    githubToken: o.githubToken ?? "test-github-token",
    llmProvider: o.llmProvider ?? "openai",
    llmBaseUrl: o.llmBaseUrl ?? "https://llm.example/v1",
    llmApiStyle: o.llmApiStyle ?? "auto",
    llmPath: "",
    llmModel: o.llmModel ?? "gpt-test",
    llmApiKey: o.llmApiKey ?? "test-llm-key",
    llmMaxTokens: 2000,
    failLevel: o.failLevel ?? "warning",
    maxDiffChars: o.maxDiffChars ?? 60000,
    maxPromptChars: o.maxPromptChars ?? 120000,
    maxFindings: o.maxFindings ?? DEFAULT_MAX_FINDINGS,
    maxInlineComments: o.maxInlineComments ?? DEFAULT_MAX_INLINE_COMMENTS,
    maxReviewBodyChars: o.maxReviewBodyChars ?? DEFAULT_MAX_REVIEW_BODY_CHARS,
    maxArtifactBytes: o.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES,
    postComment: o.postComment ?? true,
    timeoutSeconds: 90,
    prNumber: o.prNumber === undefined ? 7 : o.prNumber,
    llmAgent: o.llmAgent ?? false,
    llmAgentMaxTurns: 10,
    llmAgentMaxSeconds: 180,
  };
}

interface MockOpts {
  githubToken?: string;
  llmAgent?: boolean;
  /** Drive one linked-repo tool call through the agent ToolContext (clone is expected to fail). */
  agentToolProbe?: boolean;
  /** Size in KB reported by the getRepoSize fake (default 1024). */
  repoSizeKb?: number;
  llmApiKey?: string;
  prBody?: string;
  forkReadonly?: boolean;
  postComment?: boolean;
  binaryOnly?: boolean;
  prNumber?: number | null;
  modelCheck?: "listed" | "absent" | "unknown";
  write403?: boolean;
  staleDuringPost?: boolean;
  issueFallback?: boolean;
  issue403?: boolean;
  failLevel?: "none" | "warning" | "high";
  /** Prompt budget override (default 120000, the real default). */
  maxPromptChars?: number;
  /** Diff ceiling override (default 60000, the real default). */
  maxDiffChars?: number;
  /** Total findings published (inline + body) override (default 200, the real default). */
  maxFindings?: number;
  /** Inline comments posted per review override (default 30, the real default). */
  maxInlineComments?: number;
  /** Maximum review body size in Unicode code points override (default 60000, the real default). */
  maxReviewBodyChars?: number;
  /** Maximum artifact read bytes override (default 8388608, the real default). */
  maxArtifactBytes?: number;
  /** Issue body returned by the getIssueBody fake (default "issue text"). */
  issueBody?: string;
  llm?: Finding[];
  /** Verdicts returned by the mocked slow-path LLM seams (single-shot only; agent seams never carry verdicts). */
  llmVerdicts?: DedupVerdicts;
  headMoves?: boolean;
  /** getPr throws once the call count exceeds this number. */
  failGetPrAfter?: number;
  diff?: string;
  action?: string;
  sbomMissing?: boolean;
  /** Re-trigger via an issue comment (non-pull_request event). */
  comment?: boolean;
  /** Files created under the work dir (real on-disk sizes for L0's large-file rule). */
  workFiles?: Record<string, number>;
  /** Pre-existing summary bytes written before the run (F15 summary-budget tests). */
  summaryPrefill?: string;
  /** Findings returned by the runScanners fake (default []). */
  scan?: Finding[];
  tokenType?: "app" | "workflow-run" | "github-token";
  llmProvider?: LlmProvider;
  llmModel?: string;
  llmApiStyle?: LlmApiStyle;
  /** Empty string falls back to the provider preset base URL. */
  llmBaseUrl?: string;
  /** Use the real callWithProbe driver for analysis.callWithProbe (fetch is stubbed by the test). */
  realLlm?: boolean;
}

async function runWithMocks(o: MockOpts = {}) {
  const root = scratch();
  const artifactDir = join(root, "out");
  mkdirSync(artifactDir);
  writeFileSync(join(artifactDir, "diff.patch"), o.diff ?? (o.binaryOnly ? BINARY : DIFF));
  for (const [name, size] of Object.entries(o.workFiles ?? {})) writeFileSync(join(root, name), Buffer.alloc(size));
  const summaryPath = join(root, "summary.md");
  writeFileSync(summaryPath, "");
  if (o.summaryPrefill !== undefined) appendFileSync(summaryPath, o.summaryPrefill, "utf8");
  const rec = newRec();
  const sbomDir = join(root, "sbom-x");
  if (o.sbomMissing) mkdirSync(sbomDir);

  const commentPayload = {
    action: "created",
    comment: { body: "/review", author_association: "MEMBER" },
    issue: { number: 7, pull_request: { url: "https://api.example/pulls/7" } },
  };
  const env: RunEnv = {
    eventName: o.comment ? "issue_comment" : o.prNumber === null ? "workflow_dispatch" : "pull_request",
    payload: o.comment
      ? commentPayload
      : o.prNumber === null
        ? {}
        : { action: o.action ?? "synchronize", pull_request: { number: 7 } },
    inputs: inputsFor(o),
    workDir: root,
    artifactDir,
    baseSha: SHA_BASE,
    headSha: SHA_HEAD,
    tokenType: o.tokenType ?? "github-token",
    issueFallback: o.issueFallback === true,
    summaryPath,
  };

  const deps: Deps = {
    gh: gatewayFor(rec, {
      write403: o.write403,
      staleDuringPost: o.staleDuringPost,
      issue403: o.issue403,
      headMoves: o.headMoves,
      failGetPrAfter: o.failGetPrAfter,
      body: o.prBody,
      repoSizeKb: o.repoSizeKb,
      issueBody: o.issueBody,
      info: { isFork: o.forkReadonly === true, headRepo: o.forkReadonly ? "fork/r" : "o/r" },
    }),
    analysis: {
      runScanners: async () => {
        rec.scanEnv = { ...process.env };
        return o.sbomMissing ? { findings: [], sbomPath: join(sbomDir, "sbom.cdx.json") } : { findings: o.scan ?? [] };
      },
      runL2: async (_dir, changedFiles) => {
        rec.l2Env = { ...process.env };
        rec.l2Changed = changedFiles;
        return [];
      },
      ensureOllama: async () => {
        rec.ollamaCalled += 1;
      },
      checkModelListed: async (_baseUrl, _model, _key, protocol) => {
        rec.modelProtocol = protocol;
        return { status: o.modelCheck ?? "listed" };
      },
      callByStyle: async (_ep, messages) => {
        rec.llmCalled += 1;
        rec.llmVia = "style";
        rec.prompts = messages as { system: string; user: string };
        return { ok: true, findings: o.llm ?? [LLM_FINDING], ...(o.llmVerdicts !== undefined ? { verdicts: o.llmVerdicts } : {}) };
      },
      callWithProbe:
        o.realLlm === true
          ? async (provider, model, baseUrl, apiKey, messages, opts) =>
              (await callWithProbe(provider, model, baseUrl, apiKey, messages, opts)).result
          : async (_provider, _model, _baseUrl, _key, messages) => {
              rec.llmCalled += 1;
              rec.llmVia = "probe";
              rec.prompts = messages as { system: string; user: string };
              // The slow path runs after the early findings.json write, so snapshot the
              // file here: this is the first (fast-findings-only) payload, before the
              // merged write below overwrites it.
              try {
                rec.earlyFindingsRaw = readFileSync(join(artifactDir, "findings.json"), "utf8");
              } catch {
                // No early payload on disk; leave earlyFindingsRaw unset.
              }
              return { ok: true, findings: o.llm ?? [LLM_FINDING], ...(o.llmVerdicts !== undefined ? { verdicts: o.llmVerdicts } : {}) };
            },
      callByStyleAgent: async (_ep, conv, opts, toolCtx) => {
        rec.agentCalled += 1;
        rec.agentVia = "style";
        rec.agentTools = (conv as { tools?: unknown }).tools;
        rec.agentConv = conv;
        rec.agentToolCtx = toolCtx as ToolContext | undefined;
        rec.agentMaxTurns = (opts as { maxTurns?: number }).maxTurns;
        rec.agentMaxSeconds = (opts as { maxSeconds?: number }).maxSeconds;
        return { ok: true, findings: o.llm ?? [LLM_FINDING] };
      },
      callWithProbeAgent: async (_provider, _model, _baseUrl, _key, conv, opts, toolCtx) => {
        rec.agentCalled += 1;
        rec.agentVia = "probe";
        rec.agentTools = (conv as { tools?: unknown }).tools;
        rec.agentConv = conv;
        rec.agentToolCtx = toolCtx as ToolContext | undefined;
        rec.agentMaxTurns = (opts as { maxTurns?: number }).maxTurns;
        rec.agentMaxSeconds = (opts as { maxSeconds?: number }).maxSeconds;
        if (o.agentToolProbe === true) {
          const res = await executeTool("read_file", { path: "README.md", repo: "someone/else" }, toolCtx);
          rec.toolOutput = res.output;
          rec.toolError = res.isError;
        }
        return { ok: true, findings: o.llm ?? [LLM_FINDING] };
      },
    },
  };

  const out = await run(env, deps);
  return {
    ...out,
    issueBodyFetched: rec.issueBodyFetched,
    reviews: rec.reviews,
    reviewAttempts: rec.reviewAttempts,
    issueComments: rec.issueComments,
    getPrCalls: rec.getPrCalls,
    modelProtocol: rec.modelProtocol,
    body: rec.reviews.at(-1)?.body,
    llmCalled: rec.llmCalled,
    llmVia: rec.llmVia,
    agentCalled: rec.agentCalled,
    agentVia: rec.agentVia,
    agentTools: rec.agentTools,
    agentMaxTurns: rec.agentMaxTurns,
    agentMaxSeconds: rec.agentMaxSeconds,
    agentConv: rec.agentConv,
    agentToolCtx: rec.agentToolCtx,
    toolOutput: rec.toolOutput,
    toolError: rec.toolError,
    repoSizeCalls: rec.repoSizeCalls,
    prompts: rec.prompts,
    scanEnv: rec.scanEnv,
    l2Env: rec.l2Env,
    l2Changed: rec.l2Changed,
    earlyFindingsRaw: rec.earlyFindingsRaw,
    reviewOpts: rec.reviewOpts,
    reviewBlocking: rec.reviewBlocking,
    reviewCommentKeys: rec.reviewCommentKeys,
    artifactDir,
    summaryPath,
    sbomDir,
  };
}

interface PrivOpts {
  metaPr?: number;
  prsByHead?: number[];
  findings?: unknown[];
  /** Verdicts carried by the pr-meta.json fixture (absent = the missing-key silent passthrough). */
  metaVerdicts?: DedupVerdicts;
  staleDuringPost?: boolean;
  metaHead?: string;
  /** Extra top-level keys merged into pr-meta.json (artifact-field tests). */
  metaExtra?: Record<string, unknown>;
  failLevel?: "none" | "warning" | "high";
  wrHead?: string;
  wrRepo?: string | null;
  wrBranch?: string;
  liveRepo?: string;
  liveRef?: string;
  liveSha?: string;
  diff?: string;
  maxArtifactBytes?: number;
  maxFindings?: number;
  maxInlineComments?: number;
  maxReviewBodyChars?: number;
}

/** Fluxo B. Analysis methods throw: the privileged flow must never call scanners, L2 or the LLM. */
async function runPrivileged(o: PrivOpts = {}) {
  const root = scratch();
  const artifactDir = join(root, "priv");
  mkdirSync(artifactDir);
  writeFileSync(
    join(artifactDir, "pr-meta.json"),
    JSON.stringify({
      pr_number: o.metaPr ?? 7,
      head_sha: o.metaHead ?? SHA_HEAD,
      base_sha: SHA_BASE,
      head_repo_full_name: "o/r",
      is_fork: false,
      ...(o.metaVerdicts !== undefined ? { verdicts: o.metaVerdicts } : {}),
      ...o.metaExtra,
    }),
  );
  writeFileSync(join(artifactDir, "findings.json"), JSON.stringify(o.findings ?? [LLM_FINDING]));
  writeFileSync(join(artifactDir, "diff.patch"), o.diff ?? DIFF);
  const summaryPath = join(root, "summary.md");
  writeFileSync(summaryPath, "");
  const env: RunEnv = {
    eventName: "workflow_run",
    payload: {
      workflow_run: {
        id: 99,
        head_sha: o.wrHead ?? SHA_HEAD,
        head_branch: o.wrBranch ?? "feature",
        head_repository: o.wrRepo === null ? null : { full_name: o.wrRepo ?? "o/r" },
        event: "pull_request",
        conclusion: "success",
      },
    },
    inputs: inputsFor({
      maxArtifactBytes: o.maxArtifactBytes,
      maxFindings: o.maxFindings,
      maxInlineComments: o.maxInlineComments,
      maxReviewBodyChars: o.maxReviewBodyChars,
      ...(o.failLevel !== undefined ? { failLevel: o.failLevel } : {}),
    }),
    workDir: root,
    artifactDir,
    baseSha: SHA_BASE,
    headSha: SHA_HEAD,
    tokenType: "github-token",
    issueFallback: false,
    summaryPath,
  };
  const rec = newRec();
  const spyFail = (name: string) => () => {
    throw new Error(`${name} must not be invoked in the privileged flow`);
  };
  const deps: Deps = {
    gh: gatewayFor(rec, {
      prsByHead: o.prsByHead,
      staleDuringPost: o.staleDuringPost,
      info: { headRepo: o.liveRepo ?? "o/r", headRef: o.liveRef ?? "feature", headSha: o.liveSha ?? SHA_HEAD },
    }),
    analysis: {
      runScanners: spyFail("scanners"),
      runL2: spyFail("l2"),
      ensureOllama: spyFail("ollama"),
      checkModelListed: spyFail("models"),
      callByStyle: spyFail("llm"),
      callWithProbe: spyFail("llm"),
      callByStyleAgent: spyFail("llm-agent"),
      callWithProbeAgent: spyFail("llm-agent"),
    },
  };
  const out = await run(env, deps);
  return { ...out, reviews: rec.reviews, payloads: rec.reviews, reviewAttempts: rec.reviewAttempts, summaryPath };
}

describe("run() orchestration", () => {
  it("no llm key still posts fast-path review", async () => {
    const r = await runWithMocks({ llmApiKey: "" });
    expect(r.posted).toBe(true);
    expect(r.findingsFrom).toBe("fastpath");
    expect(r.llmCalled).toBe(0);
  });

  it("linked issue body enriches prompt when Fixes #n", async () => {
    const r = await runWithMocks({ prBody: "Fixes #12" });
    expect(r.issueBodyFetched).toBe(12);
  });

  it("fork readonly posts nothing, writes summary + artifact", async () => {
    const r = await runWithMocks({ forkReadonly: true });
    expect(r.posted).toBe(false);
    expect(r.summaryWritten).toBe(true);
    expect(r.reviewAttempts).toBe(0);
    expect(readFileSync(join(r.artifactDir, "diff.patch"), "utf8")).toContain("src/a.ts");
    expect(readFileSync(join(r.artifactDir, "pr-meta.json"), "utf8")).toContain('"is_fork": true');
  });

  it("privileged flow posts the artifact review", async () => {
    const calls = await runPrivileged();
    expect(calls.posted).toBe(true);
    expect(calls.payloads).toHaveLength(1);
  });

  it("post_comment false and resolve-null/binary dry-run without post", async () => {
    const r = await runWithMocks({ postComment: false });
    expect(r.posted).toBe(false);
    const b = await runWithMocks({ binaryOnly: true });
    expect(b.posted).toBe(true);
    expect(b.slowPathSkipped).toBe(true);
    expect(b.exitCode).toBe(0);
    expect(b.body).toContain("binary-note");
    const n = await runWithMocks({ prNumber: null });
    expect(n.posted).toBe(false);
    expect(n.exitCode).toBe(0);
  });

  it("dry-run logs the event and finding counts it would have posted", async () => {
    const info = vi.mocked(core.info);
    info.mockClear();
    const r = await runWithMocks({ postComment: false });
    expect(r.posted).toBe(false);
    const lines = info.mock.calls.map((c) => String(c[0]));
    const dry = lines.find((l) => l.includes("dry-run, nothing posted"));
    // Fixture: one warning finding on src/a.ts:2, which is an added line in DIFF, so it maps inline.
    expect(dry).toBe(
      "post_comment is false: dry-run, nothing posted (would post event=COMMENT, inline=1, general=0, high=0, blocking=1, omitted=0)",
    );
  });

  it("dry-run counts high findings and REQUEST_CHANGES with fail_level high", async () => {
    const info = vi.mocked(core.info);
    info.mockClear();
    const high: Finding = { ...LLM_FINDING, severity: "high", message: "high message" };
    const r = await runWithMocks({ postComment: false, failLevel: "high", llm: [high] });
    expect(r.posted).toBe(false);
    const dry = info.mock.calls.map((c) => String(c[0])).find((l) => l.includes("dry-run, nothing posted"));
    expect(dry).toBe(
      "post_comment is false: dry-run, nothing posted (would post event=REQUEST_CHANGES, inline=1, general=0, high=1, blocking=1, omitted=0)",
    );
  });

  it("an inconclusive model check warns and continues to inference", async () => {
    vi.mocked(core.warning).mockClear();
    const r = await runWithMocks({ modelCheck: "unknown" });
    expect(r.posted).toBe(true);
    expect(r.slowPathSkipped).toBe(false);
    expect(r.findingsFrom).not.toBe("fastpath");
    expect(r.llmCalled).toBeGreaterThan(0);
    expect(vi.mocked(core.warning).mock.calls.some(([message]) => String(message).includes("model check inconclusive"))).toBe(true);
  });

  it("an absent model skips the slow path with a warning but still posts fast-path", async () => {
    vi.mocked(core.warning).mockClear();
    const r = await runWithMocks({ modelCheck: "absent" });
    expect(r.posted).toBe(true);
    expect(r.slowPathSkipped).toBe(true);
    expect(r.findingsFrom).toBe("fastpath");
    expect(r.llmCalled).toBe(0);
    expect(vi.mocked(core.warning).mock.calls.some(([message]) => String(message).includes("is not listed by the provider"))).toBe(true);
  });

  it("missing pr-meta.json in the privileged flow is a clear error and posts nothing", async () => {
    const root = scratch();
    const artifactDir = join(root, "empty");
    mkdirSync(artifactDir);
    writeFileSync(join(artifactDir, "diff.patch"), DIFF);
    writeFileSync(join(artifactDir, "findings.json"), "[]");
    const rec = newRec();
    const env: RunEnv = {
      eventName: "workflow_run",
      payload: { workflow_run: { head_sha: SHA_HEAD } },
      inputs: inputsFor({}),
      workDir: root,
      artifactDir,
      baseSha: SHA_BASE,
      headSha: SHA_HEAD,
      tokenType: "app",
      issueFallback: false,
    };
    const deps: Deps = {
      gh: gatewayFor(rec, {}),
      analysis: {
        runScanners: () => {
          throw new Error("scanners must not run");
        },
        runL2: () => {
          throw new Error("l2 must not run");
        },
        ensureOllama: () => {
          throw new Error("ollama must not run");
        },
        checkModelListed: () => {
          throw new Error("models must not run");
        },
        callByStyle: () => {
          throw new Error("llm must not run");
        },
        callWithProbe: () => {
          throw new Error("llm must not run");
        },
        callByStyleAgent: () => {
          throw new Error("llm-agent must not run");
        },
        callWithProbeAgent: () => {
          throw new Error("llm-agent must not run");
        },
      },
    };
    await expect(run(env, deps)).rejects.toThrow(/pr-meta\.json/);
    expect(rec.reviews).toHaveLength(0);
  });

  it("stale head: the review is skipped when the PR head moved before the POST", async () => {
    const r = await runWithMocks({ headMoves: true });
    expect(r.posted).toBe(false);
    expect(r.reviewAttempts).toBe(0);
    expect(r.getPrCalls).toBe(2);
  });

  it("stale head during posting skips the review with a note and exit 0", async () => {
    const r = await runWithMocks({ staleDuringPost: true });
    expect(r.reviews).toHaveLength(0);
    expect(r.posted).toBe(false);
    expect(r.staleSkipped).toBe(true);
    const summary = readFileSync(r.summaryPath, "utf8");
    expect(summary).toContain("skipping review for the stale head");
    expect(summary).toContain(
      `lupa: PR head moved during posting; analyzed ${SHA_HEAD}, live ${SHA_OTHER}; skipping review for the stale head — a fresh run will cover the new head.`,
    );
    expect(r.exitCode).toBe(0);
  });

  it("stale head on the Flow B path skips with the same note", async () => {
    const r = await runPrivileged({ staleDuringPost: true });
    expect(r.reviews).toHaveLength(0);
    expect(r.posted).toBe(false);
    expect(r.staleSkipped).toBe(true);
    const summary = readFileSync(r.summaryPath, "utf8");
    expect(summary).toContain(
      `lupa: PR head moved during posting; analyzed ${SHA_HEAD}, live ${SHA_OTHER}; skipping review for the stale head — a fresh run will cover the new head.`,
    );
    expect(r.exitCode).toBe(0);
  });

  it("ReadonlyTokenError on a writable token (real 403 path) posts nothing and is not a crash", async () => {
    const r = await runWithMocks({ write403: true });
    expect(r.reviewAttempts).toBe(1);
    expect(r.posted).toBe(false);
    expect(r.issueComments).toHaveLength(0);
    expect(r.summaryWritten).toBe(true);
  });

  it("Step Summary includes an inline-only finding and its remediation", async () => {
    const finding = { ...LLM_FINDING, suggestion: "Use a bounded check." };
    const normal = await runWithMocks({ llm: [finding] });
    const summary = readFileSync(normal.summaryPath, "utf8");
    for (const text of ["warning", "src/a.ts:2", "logic", "llm message", "Suggested remediation (advice only)", "Use a bounded check."]) {
      expect(summary).toContain(text);
    }
  });

  it("dry-run Step Summary includes an inline-only finding and its remediation", async () => {
    const finding = { ...LLM_FINDING, suggestion: "Keep this advice." };
    const dry = await runWithMocks({ postComment: false, llm: [finding] });
    expect(dry.posted).toBe(false);
    const summary = readFileSync(dry.summaryPath, "utf8");
    for (const text of ["warning", "src/a.ts:2", "logic", "llm message", "Suggested remediation (advice only)", "Keep this advice."]) {
      expect(summary).toContain(text);
    }
  });

  it("issue fallback publishes the complete report for an inline-only finding", async () => {
    const finding = { ...LLM_FINDING, suggestion: "Use a bounded check." };
    const refused = await runWithMocks({ write403: true, issueFallback: true, llm: [finding] });
    const summary = readFileSync(refused.summaryPath, "utf8");
    for (const text of ["warning", "src/a.ts:2", "logic", "llm message", "Use a bounded check."]) {
      expect(refused.issueComments[0]).toContain(text);
    }
    expect(refused.issueComments[0]).toBe(summary.trimEnd());
    expect(refused.posted).toBe(true);
  });

  it("complete fallback report stays out of the compact review body", async () => {
    const finding = { ...LLM_FINDING, suggestion: "Use a bounded check." };
    const normal = await runWithMocks({ llm: [finding] });
    expect(normal.reviews[0]!.comments[0]!.body).toContain(finding.message);
    expect(normal.reviews[0]!.comments[0]!.body).toContain(finding.suggestion);
    expect(normal.reviews[0]!.body).toContain("1 finding(s)");
    expect(normal.reviews[0]!.body).not.toContain(finding.message);
    expect(normal.reviews[0]!.body).not.toContain(finding.suggestion);
  });

  it("normal Step Summary redacts GitHub and LLM secrets", async () => {
    const githubToken = "gh-secret-token-123";
    const llmApiKey = "sk-secret-key-456";
    const leaked: Finding = {
      severity: "warning",
      file: `src/${githubToken}-${llmApiKey}.ts`,
      line: 2,
      rule: `${githubToken}-${llmApiKey}`,
      message: `${githubToken} ${llmApiKey}`,
      suggestion: `replace ${githubToken} ${llmApiKey}`,
    };
    const result = await runWithMocks({ githubToken, llmApiKey, llm: [leaked] });
    const summary = readFileSync(result.summaryPath, "utf8");
    expect(summary).not.toContain(githubToken);
    expect(summary).not.toContain(llmApiKey);
    for (const redacted of ["src/[REDACTED]-[REDACTED].ts:2", "[REDACTED]-[REDACTED]", "[REDACTED] [REDACTED]", "replace [REDACTED] [REDACTED]"]) {
      expect(summary).toContain(redacted);
    }
  });

  it("dry-run Step Summary redacts GitHub and LLM secrets", async () => {
    const githubToken = "gh-secret-token-123";
    const llmApiKey = "sk-secret-key-456";
    const leaked: Finding = {
      severity: "warning",
      file: `src/${githubToken}-${llmApiKey}.ts`,
      line: 2,
      rule: `${githubToken}-${llmApiKey}`,
      message: `${githubToken} ${llmApiKey}`,
      suggestion: `replace ${githubToken} ${llmApiKey}`,
    };
    const result = await runWithMocks({ githubToken, llmApiKey, postComment: false, llm: [leaked] });
    expect(result.posted).toBe(false);
    const summary = readFileSync(result.summaryPath, "utf8");
    expect(summary).not.toContain(githubToken);
    expect(summary).not.toContain(llmApiKey);
    for (const redacted of ["src/[REDACTED]-[REDACTED].ts:2", "[REDACTED]-[REDACTED]", "[REDACTED] [REDACTED]", "replace [REDACTED] [REDACTED]"]) {
      expect(summary).toContain(redacted);
    }
  });

  it("issue fallback redacts both fallback report destinations", async () => {
    const githubToken = "gh-secret-token-123";
    const llmApiKey = "sk-secret-key-456";
    const leaked: Finding = {
      severity: "warning",
      file: `src/${githubToken}-${llmApiKey}.ts`,
      line: 2,
      rule: `${githubToken}-${llmApiKey}`,
      message: `${githubToken} ${llmApiKey}`,
      suggestion: `replace ${githubToken} ${llmApiKey}`,
    };
    const result = await runWithMocks({ githubToken, llmApiKey, write403: true, issueFallback: true, llm: [leaked] });
    const summary = readFileSync(result.summaryPath, "utf8");
    for (const output of [summary, result.issueComments[0]!]) {
      expect(output).not.toContain(githubToken);
      expect(output).not.toContain(llmApiKey);
      expect(output).toContain("replace [REDACTED] [REDACTED]");
    }
  });

  it("issue fallback posts a summary comment when the review is refused and fallback is enabled", async () => {
    const r = await runWithMocks({ write403: true, issueFallback: true });
    expect(r.reviewAttempts).toBe(1);
    expect(r.issueComments).toHaveLength(1);
    expect(r.issueComments[0]).toContain("lupa: 1 finding(s).");
    expect(r.posted).toBe(true);
  });

  it("fallback 403 + fail_level none: warning only, exit 0, posted false", async () => {
    const r = await runWithMocks({ write403: true, issueFallback: true, issue403: true, failLevel: "none" });
    expect(r.posted).toBe(false);
    expect(r.exitCode).toBe(0);
  });

  it("fail_level high exits 1 on high-severity evidence through run()", async () => {
    const high: Finding = { severity: "high", file: "src/a.ts", line: 2, rule: "sec", message: "bad" };
    const r = await runWithMocks({ failLevel: "high", llm: [high] });
    expect(r.exitCode).toBe(1);
    expect(r.posted).toBe(true);
  });

  it("fail_level warning exits 2 on warning findings through run()", async () => {
    const r = await runWithMocks({ failLevel: "warning" });
    expect(r.exitCode).toBe(2);
    expect(r.posted).toBe(true);
  });

  it("a non-triggering event is a no-op with exit 0 and no API calls", async () => {
    const r = await runWithMocks({ action: "closed" });
    expect(r.posted).toBe(false);
    expect(r.exitCode).toBe(0);
    expect(r.getPrCalls).toBe(0);
    expect(r.llmCalled).toBe(0);
  });

  it("scanners and L2 see a scrubbed env; the parent env is restored afterwards", async () => {
    const saved = { ...process.env };
    process.env.PR_TEST_API_TOKEN = "t-secret";
    process.env.MY_SERVICE_KEY = "k-secret";
    process.env.GITHUB_TOKEN = "ghs_secret";
    process.env.ACTIONS_RUNTIME_TOKEN = "rt-secret";
    process.env.RUNNER_TEMP = "/tmp/opencode/rt";
    try {
      const r = await runWithMocks({});
      for (const env of [r.scanEnv, r.l2Env]) {
        expect(env).toBeDefined();
        expect(env?.PR_TEST_API_TOKEN).toBeUndefined();
        expect(env?.MY_SERVICE_KEY).toBeUndefined();
        expect(env?.GITHUB_TOKEN).toBeUndefined();
        expect(env?.ACTIONS_RUNTIME_TOKEN).toBeUndefined();
        expect(env?.PATH).toBe(process.env.PATH);
        expect(env?.RUNNER_TEMP).toBe("/tmp/opencode/rt");
      }
      expect(process.env.PR_TEST_API_TOKEN).toBe("t-secret");
      expect(process.env.GITHUB_TOKEN).toBe("ghs_secret");
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });

  it("passes the parsed-diff changed set to runL2", async () => {
    const r = await runWithMocks({ scan: [] });
    expect(r.l2Changed).toEqual(new Set(["src/a.ts"])); // exact changed paths of the DIFF fixture
  });

  it("the LLM slow path keeps its key (not scrubbed; it is intended API use)", async () => {
    const r = await runWithMocks({ llmApiKey: "sk-live" });
    expect(r.llmCalled).toBe(1);
  });

  // Spec §9.5 seam selection: plain auto → the probe seam; an explicit
  // llm_api_style → the resolved endpoint's adapter, no probe.
  it("slow path: plain auto routes through the probe seam (callWithProbe)", async () => {
    const r = await runWithMocks({});
    expect(r.posted).toBe(true);
    expect(r.llmCalled).toBe(1);
    expect(r.llmVia).toBe("probe");
  });

  it("slow path: an explicit llm_api_style routes through callByStyle, no probe", async () => {
    const r = await runWithMocks({ llmApiStyle: "openai-responses" });
    expect(r.posted).toBe(true);
    expect(r.llmCalled).toBe(1);
    expect(r.llmVia).toBe("style");
  });

  it("llm_agent true routes through callWithProbeAgent with tools and maxTurns/maxSeconds", async () => {
    const r = await runWithMocks({ llmAgent: true });
    expect(r.posted).toBe(true);
    expect(r.agentCalled).toBe(1);
    expect(r.agentVia).toBe("probe");
    expect(r.llmCalled).toBe(0);
    expect(r.agentTools).toEqual(TOOL_DEFS);
    expect(r.agentMaxTurns).toBe(10);
    expect(r.agentMaxSeconds).toBe(180);
  });

  it("llm_agent false does not route through the agent methods (single-shot path unchanged)", async () => {
    const r = await runWithMocks({});
    expect(r.agentCalled).toBe(0);
    expect(r.llmVia).toBe("probe");
    expect(r.llmCalled).toBe(1);
    expect(r.getPrCalls).toBe(2);
  });

  it("publishReview redacts github_token and llm_api_key from findings before posting", async () => {
    const leaked: Finding = {
      severity: "warning",
      file: "src/a.ts",
      line: 2,
      rule: "leak-gh-secret-token-123",
      message: "saw gh-secret-token-123 and sk-secret-key-456 in code",
      suggestion: "rotate gh-secret-token-123, not sk-secret-key-456",
    };
    const r = await runWithMocks({
      githubToken: "gh-secret-token-123",
      llmApiKey: "sk-secret-key-456",
      llm: [leaked],
    });
    expect(r.posted).toBe(true);
    const dumped = JSON.stringify(r.reviews);
    expect(dumped).not.toContain("gh-secret-token-123");
    expect(dumped).not.toContain("sk-secret-key-456");
    expect(dumped).toContain("[REDACTED]");
  });

  it("fast findings echoing the token are masked in the early findings.json", async () => {
    const fast: Finding = {
      severity: "warning",
      file: "src/a.ts",
      line: 2,
      rule: "tok-rule",
      message: "saw tok-live-123 in scanner output",
    };
    // Slow path runs (default llm key): the merged write below would mask a raw early
    // write, so the early site is pinned via the payload the slow-path seam observed —
    // the first, fast-findings-only write, before the merge overwrote it.
    const r = await runWithMocks({ githubToken: "tok-live-123", scan: [fast] });
    expect(r.llmCalled).toBe(1);
    const early = r.earlyFindingsRaw;
    expect(early).toBeDefined();
    const parsed = JSON.parse(early!) as Finding[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.rule).toBe("tok-rule");
    expect(early!).not.toContain("tok-live-123");
    expect(early!).toContain("[REDACTED]");
    const raw = readFileSync(join(r.artifactDir, "findings.json"), "utf8");
    expect(raw).not.toContain("tok-live-123");
    expect(raw).toContain("[REDACTED]");
  });

  it("merged findings and sarif.json are masked and sarif stays valid", async () => {
    const leaked: Finding = {
      severity: "warning",
      file: "src/a.ts",
      line: 2,
      rule: "llm-rule",
      message: "key key-live-456 echoed by the model",
    };
    const r = await runWithMocks({ llmApiKey: "key-live-456", llm: [leaked] });
    const merged = readFileSync(join(r.artifactDir, "findings.json"), "utf8");
    expect(merged).not.toContain("key-live-456");
    expect(merged).toContain("[REDACTED]");
    const sarif = JSON.parse(readFileSync(join(r.artifactDir, "sarif.json"), "utf8"));
    expect(sarif.version).toBe("2.1.0");
    expect(JSON.stringify(sarif)).not.toContain("key-live-456");
  });

  it("linked alias clone failure still posts the review (tool error only)", async () => {
    const r = await runWithMocks({
      llmAgent: true,
      agentToolProbe: true,
      prBody: "See https://github.com/someone/else for context",
    });
    expect(r.posted).toBe(true);
    expect(r.toolError).toBe(true);
    // Gating passes (the body links someone/else), so the real clone is attempted and fails;
    // the size pre-check inside ensureLinkedRepo proves the clone path was reached.
    expect(r.toolOutput).toContain("repository not accessible: someone/else");
    expect(r.repoSizeCalls).toContainEqual(["someone", "else"]);
  });

  it("oversized linked repo is short-circuited by the size guard (no clone) and the review still posts", async () => {
    const info = vi.mocked(core.info);
    info.mockClear();
    const r = await runWithMocks({
      llmAgent: true,
      agentToolProbe: true,
      prBody: "See https://github.com/someone/else for context",
      repoSizeKb: 300000000,
    });
    expect(r.posted).toBe(true);
    expect(r.toolError).toBe(true);
    // The size guard short-circuits before any clone: the tool surfaces the
    // not-accessible error while getRepoSize proves the pre-check ran.
    expect(r.toolOutput).toContain("repository not accessible: someone/else");
    expect(r.repoSizeCalls).toContainEqual(["someone", "else"]);
    const lines = info.mock.calls.map((c) => String(c[0]));
    expect(lines).toContain("agent linked repositories: someone/else");
  });

  it("agent slow path makes no second getPr fetch (body is threaded through)", async () => {
    const r = await runWithMocks({ llmAgent: true });
    expect(r.posted).toBe(true);
    expect(r.agentCalled).toBe(1);
    // runFlowA fetch + publishReview head check; the slow path must not fetch again.
    expect(r.getPrCalls).toBe(2);
  });

  it("agent slow path still posts when a late getPr call fails", async () => {
    const r = await runWithMocks({ llmAgent: true, failGetPrAfter: 2 });
    expect(r.posted).toBe(true);
    expect(r.getPrCalls).toBe(2);
  });

  it("agent mode refuses unlinked aliases and tells the model the linked aliases", async () => {
    const r = await runWithMocks({ llmAgent: true, prBody: "See https://github.com/someone/else for context" });
    expect(r.posted).toBe(true);
    expect(r.agentToolCtx?.ensureLinked).toBeDefined();
    const refused = await r.agentToolCtx!.ensureLinked!("evil/x");
    expect(refused).toEqual({ error: "repository not accessible: evil/x" });
    const turns =
      (r.agentConv as { turns?: Array<{ role?: string; text?: string }> } | undefined)?.turns ?? [];
    expect(
      turns.some(
        (t) => t.role === "user" && (t.text ?? "").includes("Linked repositories mentioned in this pull request: someone/else"),
      ),
    ).toBe(true);
  });

  it("unlinked alias is refused at the gate while a mixed-case linked alias passes it", async () => {
    const r = await runWithMocks({ llmAgent: true, prBody: "See https://github.com/someone/else for context" });
    expect(r.posted).toBe(true);
    const gate = r.agentToolCtx!.ensureLinked!;
    expect(await gate("evil/x")).toEqual({ error: "repository not accessible: evil/x" });
    // Refusal happened at the gate: ensureLinkedRepo (and its getRepoSize pre-check) never ran.
    expect(r.repoSizeCalls).not.toContainEqual(["evil", "x"]);
    // Mixed-case linked alias passes the gate: the size pre-check sees the alias as passed through.
    await gate("Someone/Else");
    expect(r.repoSizeCalls).toContainEqual(["Someone", "Else"]);
  });

  it("logs the linked repo SHA on reuse", async () => {
    const prevRunnerTemp = process.env.RUNNER_TEMP;
    const scratchDir = scratch();
    process.env.RUNNER_TEMP = scratchDir;
    try {
      const dir = join(scratchDir, "lupa-linked", "someone__else");
      mkdirSync(dir, { recursive: true });
      execFileSync("git", ["init", "-b", "main"], { cwd: dir });
      execFileSync("git", ["remote", "add", "origin", "https://github.com/someone/else.git"], { cwd: dir });
      execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"], {
        cwd: dir,
      });
      const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
      writeFileSync(join(dir, ".lupa-clone.json"), JSON.stringify({ repo: "someone/else", branch: "main", sha }));
      const info = vi.mocked(core.info);
      info.mockClear();
      const r = await runWithMocks({
        llmAgent: true,
        agentToolProbe: true,
        prBody: "See https://github.com/someone/else for context",
      });
      expect(r.posted).toBe(true);
      const lines = info.mock.calls.map((c) => String(c[0]));
      expect(lines).toContain(`agent linked repo someone/else at ${sha}`);
    } finally {
      if (prevRunnerTemp === undefined) delete process.env.RUNNER_TEMP;
      else process.env.RUNNER_TEMP = prevRunnerTemp;
    }
  });

  // Task 19 wiring: with plain `auto` the slow path probes (error-driven, spec §9.5) —
  // chat 404s for zen gpt-6-luna, the probe advances and the responses adapter
  // answers, so a non-chat pair works end-to-end without any map.
  it("slow path probes a non-chat pair through the responses adapter and posts its findings", async () => {
    const fetchMock = vi.fn(async (url: string | URL, _init?: RequestInit) =>
      String(url).endsWith("/chat/completions")
        ? new Response("not found", { status: 404 })
        : new Response(
            JSON.stringify({
              status: "completed",
              output: [
                {
                  type: "message",
                  content: [
                    {
                      type: "output_text",
                      text: JSON.stringify({ findings: [{ ...LLM_FINDING, suggestion: "sug" }] }),
                    },
                  ],
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const r = await runWithMocks({ realLlm: true, llmProvider: "opencode-zen", llmModel: "gpt-6-luna", llmBaseUrl: "" });
    expect(r.posted).toBe(true);
    expect(r.findingsFrom).toBe("llm");
    expect(JSON.stringify(r.reviews[0])).toContain("llm message");
    const call = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/responses"));
    expect(call).toBeDefined();
    expect(String(call![0])).toBe("https://opencode.ai/zen/v1/responses");
    const body = JSON.parse(String((call![1] as RequestInit).body)) as Record<string, any>;
    expect(body.model).toBe("gpt-6-luna");
    expect(body.max_output_tokens).toBe(2000);
    expect(body.input).toEqual([
      { role: "system", content: expect.any(String) },
      { role: "user", content: expect.any(String) },
    ]);
  });

  it("models check uses the OpenAI catalog by default", async () => {
    const r = await runWithMocks({});
    expect(r.modelProtocol).toBe("openai");
  });

  it("models check uses the Google catalog for the google preset speaking google-models", async () => {
    const r = await runWithMocks({ llmProvider: "google", llmApiStyle: "google-models", llmModel: "gemini-x", llmBaseUrl: "" });
    expect(r.modelProtocol).toBe("google");
    expect(r.slowPathSkipped).toBe(false);
  });

  it("models check uses the Anthropic catalog for the anthropic preset", async () => {
    const r = await runWithMocks({ llmProvider: "anthropic", llmApiStyle: "anthropic-messages", llmModel: "claude-x", llmBaseUrl: "" });
    expect(r.modelProtocol).toBe("anthropic");
    expect(r.slowPathSkipped).toBe(false);
  });

  it("a failed sbom copy is a warning and the run continues", async () => {
    const r = await runWithMocks({ sbomMissing: true });
    expect(r.posted).toBe(true);
    expect(existsSync(r.sbomDir)).toBe(false);
  });

  it("writes sarif.json from the final findings (code scanning input)", async () => {
    const r = await runWithMocks({});
    const sarif = JSON.parse(readFileSync(join(r.artifactDir, "sarif.json"), "utf8")) as {
      version: string;
      runs: { results: { ruleId: string; locations: unknown[] }[] }[];
    };
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs[0].results[0].ruleId).toBe("logic");
    expect(sarif.runs[0].results[0].locations).toHaveLength(1);
  });

  it("fork PR re-triggered by comment with an App token: L2 is skipped, a finding says so, the review still posts", async () => {
    const r = await runWithMocks({ comment: true, forkReadonly: true, tokenType: "app" });
    expect(r.l2Env).toBeUndefined();
    expect(r.body).toContain("l2-skipped");
    expect(r.posted).toBe(true);
  });

  it("same-repo comment re-trigger still runs L2", async () => {
    const r = await runWithMocks({ comment: true });
    expect(r.l2Env).toBeDefined();
    expect(r.body).not.toContain("l2-skipped");
  });

  it("quoted non-ASCII git paths decode to real names (quotePath residue)", async () => {
    const r = await runWithMocks({ diff: QUOTED_BINARY });
    expect(r.body).toContain("café.bin");
    expect(r.body).not.toContain("caf\\303");
  });
});

describe("Q02 novelty-gated blocking", () => {
  const DEL_DIFF = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,1 @@
 const x = 1;
-const gone = 1;
`;

  const SENSITIVE_DIFF = `diff --git a/id_rsa b/id_rsa
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/id_rsa
@@ -0,0 +1 @@
+private-key-material
`;

  const TWO_ADD_DIFF = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,4 @@
 const x = 1;
+const y = 2;
+const z = 3;
 export {};
`;

  it("ctx-line high stays inline but never gates: COMMENT + exit 0, no body item", async () => {
    const high: Finding = { severity: "high", file: "src/a.ts", line: 3, rule: "ctx-rule", message: "ctx high" };
    const r = await runWithMocks({ failLevel: "high", llm: [high] });
    expect(r.posted).toBe(true);
    expect(r.reviews[0]!.event).toBe("COMMENT");
    expect(r.exitCode).toBe(0);
    expect(r.reviews[0]!.comments).toHaveLength(1);
    expect(r.reviews[0]!.comments[0]).toMatchObject({ path: "src/a.ts", line: 3, side: "RIGHT" });
    expect(r.reviews[0]!.body).toBe("lupa: 1 finding(s).");
  });

  it("LEFT-only high stays inline LEFT but never gates: COMMENT + exit 0, no body item, no note", async () => {
    const high: Finding = { severity: "high", file: "src/a.ts", line: 2, rule: "del-rule", message: "removed high" };
    const r = await runWithMocks({ diff: DEL_DIFF, failLevel: "high", llm: [high] });
    expect(r.posted).toBe(true);
    expect(r.reviews[0]!.event).toBe("COMMENT");
    expect(r.exitCode).toBe(0);
    expect(r.reviews[0]!.comments).toHaveLength(1);
    expect(r.reviews[0]!.comments[0]).toMatchObject({ path: "src/a.ts", line: 2, side: "LEFT" });
    expect(r.reviews[0]!.body).toBe("lupa: 1 finding(s).");
  });

  it("lineless sensitive-path high on a touched file still blocks: REQUEST_CHANGES + exit 1", async () => {
    const r = await runWithMocks({ diff: SENSITIVE_DIFF, failLevel: "high", llm: [] });
    expect(r.posted).toBe(true);
    expect(r.reviews[0]!.event).toBe("REQUEST_CHANGES");
    expect(r.exitCode).toBe(1);
    expect(r.reviews[0]!.comments).toEqual([]);
    expect(r.reviews[0]!.body).toContain("- **high** **blocking** id_rsa [sensitive-path]");
    expect(r.reviews[0]!.body).not.toContain("outside the PR diff");
  });

  it("posted payload comments carry no rule key", async () => {
    const r = await runWithMocks({});
    expect(r.posted).toBe(true);
    expect(r.reviews[0]!.comments).toHaveLength(1);
    expect("rule" in r.reviews[0]!.comments[0]!).toBe(false);
    expect(r.reviews[0]!.comments[0]).toEqual({
      path: "src/a.ts",
      line: 2,
      side: "RIGHT",
      body: expect.stringContaining("llm message"),
    });
  });

  it("passes the computed blocking set and post-slice comment keys to the gateway", async () => {
    const llm: Finding[] = [
      { severity: "warning", file: "src/a.ts", line: 2, rule: "r1", message: "first" },
      { severity: "warning", file: "src/a.ts", line: 3, rule: "r2", message: "second" },
    ];
    const r = await runWithMocks({ diff: TWO_ADD_DIFF, llm, maxInlineComments: 1 });
    expect(r.posted).toBe(true);
    expect(r.reviews[0]!.comments).toHaveLength(1);
    // The gateway saw the full blocking set even though only one comment posted.
    expect(r.reviewBlocking).toEqual(new Set(["r1\0src/a.ts\0" + "2", "r2\0src/a.ts\0" + "3"]));
    // Keys are post-slice and index-aligned with the posted comments.
    expect(r.reviewCommentKeys).toEqual(["r1\0src/a.ts\0" + "2"]);
  });

  it("folds excess non-blocking inline comments with the (non-blocking) suffix", async () => {
    const llm: Finding[] = [
      { severity: "warning", file: "src/a.ts", line: 2, rule: "r-add", message: "added" },
      { severity: "warning", file: "src/a.ts", line: 3, rule: "r-ctx", message: "context" },
    ];
    const r = await runWithMocks({ llm, maxInlineComments: 1 });
    expect(r.posted).toBe(true);
    expect(r.body).toContain("**Findings not placed inline:**");
    expect(r.body).toContain("- src/a.ts:3 (non-blocking)");
    expect(r.body).not.toContain("- src/a.ts:2 (non-blocking)");
  });

  it("dry-run computes blocking before the early return: off-diff high keeps high=1 with blocking=0 and exit 0", async () => {
    const info = vi.mocked(core.info);
    info.mockClear();
    const high: Finding = { severity: "high", file: "src/other.ts", line: 1, rule: "off-rule", message: "off diff high" };
    const r = await runWithMocks({ postComment: false, failLevel: "high", llm: [high] });
    expect(r.posted).toBe(false);
    expect(r.exitCode).toBe(0);
    const dry = info.mock.calls.map((c) => String(c[0])).find((l) => l.includes("dry-run, nothing posted"));
    expect(dry).toBe(
      "post_comment is false: dry-run, nothing posted (would post event=COMMENT, inline=0, general=1, high=1, blocking=0, omitted=0)",
    );
    expect(r.body).toBeUndefined();
  });
});

describe("fork token type (F14)", () => {
  it.each([
    { tokenType: "app" as const, posts: true },
    { tokenType: "workflow-run" as const, posts: true },
    { tokenType: "github-token" as const, posts: false },
  ])("fork PR with tokenType $tokenType posts=$posts", async ({ tokenType, posts }) => {
    vi.mocked(core.warning).mockClear();
    const r = await runWithMocks({ forkReadonly: true, tokenType });
    expect(r.posted).toBe(posts);
    if (posts) {
      expect(r.reviewAttempts).toBe(1);
    } else {
      expect(r.reviewAttempts).toBe(0);
      expect(r.summaryWritten).toBe(true);
      expect(
        vi.mocked(core.warning).mock.calls.some(([message]) => String(message).includes("read-only token")),
      ).toBe(true);
    }
  });

  it.each(["app", "workflow-run", "github-token"] as const)("non-fork PR with tokenType %s posts", async (tokenType) => {
    const r = await runWithMocks({ tokenType });
    expect(r.posted).toBe(true);
  });

  it("UNSET PR_REVIEWER_TOKEN_TYPE parses fail-closed to github-token", () => {
    const saved = process.env.PR_REVIEWER_TOKEN_TYPE;
    delete process.env.PR_REVIEWER_TOKEN_TYPE;
    try {
      expect(readRunEnv().tokenType).toBe("github-token");
    } finally {
      if (saved === undefined) delete process.env.PR_REVIEWER_TOKEN_TYPE;
      else process.env.PR_REVIEWER_TOKEN_TYPE = saved;
    }
  });

  it("unknown PR_REVIEWER_TOKEN_TYPE parses fail-closed to github-token", () => {
    const saved = process.env.PR_REVIEWER_TOKEN_TYPE;
    process.env.PR_REVIEWER_TOKEN_TYPE = "bogus-token-type";
    try {
      expect(readRunEnv().tokenType).toBe("github-token");
    } finally {
      if (saved === undefined) delete process.env.PR_REVIEWER_TOKEN_TYPE;
      else process.env.PR_REVIEWER_TOKEN_TYPE = saved;
    }
  });

  it("Flow B ignores planted fail_level-shaped artifact fields (event and exit follow inputs)", async () => {
    const planted = { ...LLM_FINDING, severity: "high", fail_level: "none" };
    const r = await runPrivileged({ failLevel: "high", findings: [planted], metaExtra: { fail_level: "none" } });
    expect(r.posted).toBe(true);
    expect(r.payloads[0].event).toBe("REQUEST_CHANGES");
    expect(r.exitCode).toBe(1);
  });
});

describe("Fluxo B bindings and sanitizing", () => {
  it("rejects when the live PR head repository differs from workflow_run.head_repository", async () => {
    await expect(runPrivileged({ liveRepo: "evil/r" })).rejects.toThrow(/head repository/);
  });

  it("rejects a same-sha different PR (head branch differs)", async () => {
    await expect(runPrivileged({ liveRef: "other-branch" })).rejects.toThrow(/head branch/);
  });

  it("rejects when artifact head_sha differs from workflow_run.head_sha", async () => {
    await expect(runPrivileged({ metaHead: SHA_OTHER })).rejects.toThrow(/workflow_run\.head_sha/);
  });

  it("rejects when the live PR head moved after the PR run", async () => {
    await expect(runPrivileged({ liveSha: SHA_OTHER })).rejects.toThrow(/live PR head/);
  });

  it("rejects when no open PR has the workflow_run head", async () => {
    await expect(runPrivileged({ prsByHead: [] })).rejects.toThrow(/exactly one open PR/);
  });

  it("rejects when more than one open PR has the workflow_run head", async () => {
    await expect(runPrivileged({ prsByHead: [7, 9] })).rejects.toThrow(/exactly one open PR/);
  });

  it("rejects when the artifact pr_number is not the PR derived from trusted fields", async () => {
    await expect(runPrivileged({ metaPr: 8, prsByHead: [7] })).rejects.toThrow(/does not match the PR derived/);
  });

  it("accepts an uppercase artifact head_sha (compared lowercased) and posts", async () => {
    const r = await runPrivileged({ metaHead: SHA_HEAD.toUpperCase() });
    expect(r.posted).toBe(true);
  });

  it("strips C0 controls from messages (keeps tab and newline) and caps file and rule lengths", async () => {
    const f: Finding = {
      severity: "warning",
      file: "src/a.ts",
      line: 2,
      rule: "r".repeat(150),
      message: "abc\u0007def\nline\tend\u0000",
    };
    const r = await runPrivileged({ findings: [f] });
    const body = r.payloads[0].comments[0].body;
    expect(body).toContain("abcdef\nline\tend");
    expect(body).not.toContain("\u0007");
    expect(body).not.toContain("r".repeat(100));
    expect(body).toContain(TRUNC);
  });

  it("caps file paths at 200 chars (over-long safe path becomes a capped general note)", async () => {
    const f: Finding = { severity: "warning", file: "d/".repeat(150), line: 2, rule: "r", message: "m" };
    const r = await runPrivileged({ findings: [f] });
    expect(r.payloads[0].body).not.toContain("d/".repeat(120));
    expect(r.payloads[0].body).toContain(TRUNC);
  });

  it("caps by code points: an emoji message never leaves a lone surrogate", async () => {
    const f: Finding = { severity: "warning", file: "src/a.ts", line: 2, rule: "r", message: "😀".repeat(2500) };
    const r = await runPrivileged({ findings: [f] });
    const body = r.payloads[0].comments[0].body;
    expect(body).toContain(TRUNC);
    expect(body).not.toContain("😀".repeat(2000));
    expect(body).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it("caps long messages at 2000 chars and marks the truncation", async () => {
    const f: Finding = { severity: "warning", file: "src/a.ts", line: 2, rule: "r", message: "x".repeat(5000) };
    const r = await runPrivileged({ findings: [f] });
    const body = r.payloads[0].comments[0].body;
    expect(body).toContain(TRUNC);
    expect(body).not.toContain("x".repeat(2000));
  });

  it("caps long suggestions at 4000 chars and marks the truncation", async () => {
    const f: Finding = {
      severity: "warning",
      file: "src/a.ts",
      line: 2,
      rule: "r",
      message: "m",
      suggestion: "y".repeat(6000),
    };
    const r = await runPrivileged({ findings: [f] });
    const body = r.payloads[0].comments[0].body;
    expect(body).toContain(TRUNC);
    expect(body).not.toContain("y".repeat(4000));
  });

  it("a parent-traversal path becomes a repository-level note, never an inline comment", async () => {
    const f: Finding = { severity: "warning", file: "../../etc/passwd", line: 2, rule: "r", message: "m" };
    const r = await runPrivileged({ findings: [f] });
    expect(r.payloads[0].comments).toHaveLength(0);
    expect(r.payloads[0].body).toContain("artifact path rejected");
    expect(r.payloads[0].body).toContain("(repository)");
  });

  it("an absolute path becomes a repository-level note", async () => {
    const f: Finding = { severity: "warning", file: "/etc/passwd", line: 2, rule: "r", message: "m" };
    const r = await runPrivileged({ findings: [f] });
    expect(r.payloads[0].comments).toHaveLength(0);
    expect(r.payloads[0].body).toContain("artifact path rejected");
  });

  it("sanitizeFinding keeps short findings unchanged", () => {
    expect(sanitizeFinding(LLM_FINDING)).toEqual(LLM_FINDING);
  });
});

describe("finding provenance contract (Q04)", () => {
  it("readFindings accepts valid provenance shapes", () => {
    const dir = scratch();
    const valid = [
      { ...LLM_FINDING },
      { ...LLM_FINDING, source: "semgrep", confidence: 90, evidence: { analyzer: "semgrep" } },
      { ...LLM_FINDING, source: "fastpath", confidence: 50 },
      { ...LLM_FINDING, confidence: 0 },
      { ...LLM_FINDING, evidence: {} },
    ];
    writeFileSync(join(dir, "findings.json"), JSON.stringify(valid), "utf8");
    expect(readFindings(dir)).toEqual(valid);
  });

  it.each([
    ["overlong source", { source: "x".repeat(101) }],
    ["confidence 101", { confidence: 101 }],
    ["confidence -1", { confidence: -1 }],
    ["non-integer confidence", { confidence: 1.5 }],
    ["string confidence", { confidence: "90" }],
    ["non-object evidence", { evidence: "semgrep" }],
    ["non-string analyzer", { evidence: { analyzer: 42 } }],
    ["empty source", { source: "" }],
  ])("readFindings rejects %s", (_label, extra) => {
    const dir = scratch();
    writeFileSync(join(dir, "findings.json"), JSON.stringify([{ ...LLM_FINDING, ...extra }]), "utf8");
    expect(() => readFindings(dir)).toThrow("lupa: findings.json does not match the finding contract");
  });

  it("sanitizeFinding carries source, confidence and evidence with caps, absent stays absent", () => {
    const carried = sanitizeFinding({
      ...LLM_FINDING,
      source: "semgrep",
      confidence: 90,
      evidence: { analyzer: "semgrep", snippet: "line" },
    });
    expect(carried.source).toBe("semgrep");
    expect(carried.confidence).toBe(90);
    expect(carried.evidence).toEqual({ analyzer: "semgrep", snippet: "line" });
    const absent = sanitizeFinding({ ...LLM_FINDING });
    expect(absent.source).toBeUndefined();
    expect(absent.confidence).toBeUndefined();
    expect(absent.evidence).toBeUndefined();
    const capped = sanitizeFinding({
      ...LLM_FINDING,
      source: `s${"\0".repeat(5)}${"x".repeat(200)}`,
      evidence: { analyzer: `a${"\u007f".repeat(5)}${"y".repeat(200)}`, snippet: `s${"\0".repeat(3)}${"z".repeat(3000)}` },
    });
    expect(capped.source).toBe(`s${"x".repeat(200)}`.slice(0, 100 - TRUNC.length) + TRUNC);
    expect(Array.from(capped.source!)).toHaveLength(100);
    expect(Array.from(capped.evidence!.analyzer!)).toHaveLength(100);
    expect(capped.evidence!.analyzer).toContain(TRUNC);
    expect(Array.from(capped.evidence!.snippet!)).toHaveLength(2000);
    expect(capped.evidence!.snippet).toContain(TRUNC);
  });

  it("L2_SKIPPED carries source l2 with no confidence (fork path)", async () => {
    const r = await runWithMocks({ comment: true, forkReadonly: true, tokenType: "app" });
    const staged = JSON.parse(readFileSync(join(r.artifactDir, "findings.json"), "utf8")) as Finding[];
    const skipped = staged.find((f) => f.rule === "l2-skipped");
    expect(skipped).toBeDefined();
    expect(skipped!.source).toBe("l2");
    expect(skipped!.confidence).toBeUndefined();
  });
});

describe("findings from binaries, renames and skip paths", () => {
  it("a binary over 500 KB on disk triggers large-file (real stat, not hunk length)", async () => {
    const big = 'diff --git a/big.bin b/big.bin\nBinary files a/big.bin and b/big.bin differ\n';
    const r = await runWithMocks({ diff: big, workFiles: { "big.bin": 600 * 1024 } });
    expect(r.body).toContain("large-file");
    expect(r.body).toContain("binary-note");
  });

  it("a small binary does not trigger large-file", async () => {
    const small = 'diff --git a/small.bin b/small.bin\nBinary files a/small.bin and b/small.bin differ\n';
    const r = await runWithMocks({ diff: small, workFiles: { "small.bin": 10 * 1024 } });
    expect(r.body).not.toContain("large-file");
  });

  it("a rename (a != b) reports the new path, not the old one", async () => {
    const rename = [
      "diff --git a/old.bin b/new.bin",
      "similarity index 90%",
      "rename from old.bin",
      "rename to new.bin",
      "Binary files a/old.bin and b/new.bin differ",
      "",
    ].join("\n");
    const r = await runWithMocks({ diff: rename });
    expect(r.body).toContain("new.bin");
    expect(r.body).not.toContain("old.bin");
  });

  it("a quoted rename reports the decoded new path", async () => {
    const rename = [
      'diff --git "a/old.bin" "b/caf\\303\\251.bin"',
      "similarity index 90%",
      'Binary files "a/old.bin" and "b/caf\\303\\251.bin" differ',
      "",
    ].join("\n");
    const r = await runWithMocks({ diff: rename });
    expect(r.body).toContain("café.bin");
    expect(r.body).not.toContain("old.bin");
  });

  it("a non-triggering event writes a visible summary line (not an empty summary)", async () => {
    const r = await runWithMocks({ action: "closed" });
    expect(r.summaryWritten).toBe(true);
    expect(readFileSync(r.summaryPath, "utf8")).toContain("does not trigger a review");
  });

  it("an unwritable summary path on the skip path still exits 0 without throwing", async () => {
    const root = scratch();
    const artifactDir = join(root, "out");
    mkdirSync(artifactDir);
    writeFileSync(join(artifactDir, "diff.patch"), DIFF);
    const rec = newRec();
    const env: RunEnv = {
      eventName: "pull_request",
      payload: { action: "closed", pull_request: { number: 7 } },
      inputs: inputsFor({ llmApiKey: "" }),
      workDir: root,
      artifactDir,
      baseSha: SHA_BASE,
      headSha: SHA_HEAD,
      tokenType: "github-token",
      issueFallback: false,
      // A directory: appendFileSync throws EISDIR. The skip path must absorb that.
      summaryPath: root,
    };
    const fail = (name: string) => () => {
      throw new Error(`${name} must not run on a non-triggering event`);
    };
    const deps: Deps = {
      gh: gatewayFor(rec, {}),
      analysis: {
        runScanners: fail("scanners"),
        runL2: fail("l2"),
        ensureOllama: fail("ollama"),
        checkModelListed: fail("models"),
        callByStyle: fail("llm"),
        callWithProbe: fail("llm"),
        callByStyleAgent: fail("llm-agent"),
        callWithProbeAgent: fail("llm-agent"),
      },
    };
    const out = await run(env, deps);
    expect(out.posted).toBe(false);
    expect(out.exitCode).toBe(0);
    expect(rec.getPrCalls).toBe(0);
  });

  it("main() on a non-triggering event exits 0 with an EMPTY token (Octokit is built lazily)", async () => {
    const root = scratch();
    const eventPath = join(root, "event.json");
    writeFileSync(eventPath, '{"ref":"refs/heads/main"}');
    writeFileSync(join(root, "output.txt"), ""); // the runner creates GITHUB_OUTPUT; core requires it
    const keys = {
      GITHUB_EVENT_NAME: "push",
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_STEP_SUMMARY: join(root, "summary.md"),
      GITHUB_OUTPUT: join(root, "output.txt"),
      GITHUB_WORKSPACE: root,
      INPUT_POST_COMMENT: "false",
      INPUT_FAIL_LEVEL: "none",
      INPUT_GITHUB_TOKEN: "",
      INPUT_LLM_API_KEY: "",
    };
    const saved: Record<string, string | undefined> = {};
    for (const k of Object.keys(keys)) saved[k] = process.env[k];
    const savedExit = process.exitCode;
    Object.assign(process.env, keys);
    try {
      await main();
      expect(process.exitCode).toBe(0);
      expect(readFileSync(keys.GITHUB_STEP_SUMMARY, "utf8")).toContain("does not trigger a review");
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      process.exitCode = savedExit;
    }
  });

  it("SARIF carries warning and high findings only (info stays out)", async () => {
    const info: Finding = { severity: "info", file: "src/a.ts", line: 2, rule: "infoonly", message: "i" };
    const high: Finding = { severity: "high", file: "src/a.ts", line: 2, rule: "hirule", message: "h" };
    const r = await runWithMocks({ llm: [info, high], failLevel: "none" });
    const sarif = JSON.parse(readFileSync(join(r.artifactDir, "sarif.json"), "utf8")) as {
      runs: { results: { ruleId: string }[] }[];
    };
    const ids = sarif.runs[0].results.map((x) => x.ruleId);
    expect(ids).toContain("hirule");
    expect(ids).not.toContain("infoonly");
  });
});

describe("pr-meta validation (M9)", () => {
  it("readPrMeta rejects a non-hex base_sha", () => {
    const dir = scratch();
    writeFileSync(
      join(dir, "pr-meta.json"),
      JSON.stringify({ pr_number: 7, head_sha: SHA_HEAD, base_sha: "not-a-sha", head_repo_full_name: "o/r", is_fork: false }),
    );
    expect(() => readPrMeta(dir)).toThrow(/Invalid pr-meta\.json/);
  });
});

describe("exec env and git path helpers", () => {
  it("cleanEnvForExec keeps the allowlist and strips every secret-shaped name", () => {
    const clean = cleanEnvForExec({
      PATH: "/bin",
      HOME: "/h",
      LANG: "C",
      TMPDIR: "/t",
      RUNNER_TEMP: "/r",
      GITHUB_WORKSPACE: "/w",
      GITHUB_TOKEN: "x",
      ACTIONS_RUNTIME_TOKEN: "x",
      LLM_API_KEY: "x",
      DB_PASSWORD: "x",
      SOME_SECRET: "x",
      AWS_AUTH_HEADER: "x",
      RANDOM_VAR: "x",
      SEMGREP_APP_TOKEN: "x",
    });
    expect(Object.keys(clean).sort()).toEqual(["GITHUB_WORKSPACE", "HOME", "LANG", "PATH", "RUNNER_TEMP", "TMPDIR"]);
  });

  it("unquoteGitPath decodes octal escapes and passes plain names through", () => {
    expect(unquoteGitPath('"caf\\303\\251.txt"')).toBe("café.txt");
    expect(unquoteGitPath("plain.txt")).toBe("plain.txt");
    expect(unquoteGitPath('"tab\\there"')).toBe("tab\there");
  });
});

describe("prompt budget", () => {
  const countRealTags = (s: string, tag: string) =>
    (s.match(new RegExp(`<\\s*\\/?\\s*${tag}\\b[^>]*>?`, "gi")) ?? []).length;

  const diffWithHunk = (body: string, file = "src/a.ts"): string =>
    [
      `diff --git a/${file} b/${file}`,
      "index 111..222 100644",
      `--- a/${file}`,
      `+++ b/${file}`,
      "@@ -1 +1 @@",
      `+${body}`,
      "",
    ].join("\n");

  // ~2,900 B single-line hunk, DIFF format.
  const DIFF_2900 = diffWithHunk("x".repeat(2900));
  // ~2,000 B hunk (the default 141 B DIFF never reaches any budget).
  const DIFF_2000 = diffWithHunk("x".repeat(2000));

  // Pinned ≈295 B JSON (verify with Buffer.byteLength in-test).
  const SCAN_FINDING: Finding = {
    severity: "warning",
    file: "src/a.ts",
    line: 2,
    rule: "scan-rule",
    message: "m".repeat(200),
  };

  // BIG_FIRST_PATCH: 5.2 KB file first + 25 tiny files `src/fixture-source-file-00.ts` …
  // `src/fixture-source-file-24.ts` (~29-char paths → ~33 B/note-line). Exact sizes:
  // big section = 14 + 12 + 5201 + 1 = 5228 chars, leaving a ~272-char gap under
  // maxDiffChars 5500; each tiny section = 34 + 12 + 261 + 1 = 308 chars, so all 25 skip.
  // diff text ≈ 5.2 KB (< 6,000 alone), note (20 lines + "…and 5 more") ≈ 775 B,
  // total > 6,000 after the issue and findings are cut → skip.
  const BIG_FIRST_PATCH = [
    diffWithHunk("b".repeat(5200), "src/big.ts"),
    ...Array.from({ length: 25 }, (_, i) =>
      diffWithHunk("t".repeat(260), `src/fixture-source-file-${String(i).padStart(2, "0")}.ts`)),
  ].join("");

  // CJK_PATCH: 8 files × ~7,450 CJK units (each under PER_FILE_CAP 8000).
  const CJK_PATCH = Array.from({ length: 8 }, (_, i) =>
    diffWithHunk("あ".repeat(7450), `src/cjk-0${i}.ts`)).join("");

  it("truncates an oversized issue with a balanced marker", async () => {
    const r = await runWithMocks({ maxPromptChars: 4000, issueBody: "x".repeat(5000), prBody: "Fixes #7" });
    const user = r.prompts!.user;
    expect(user).toContain("…[issue context truncated to fit the prompt budget]");
    expect(countRealTags(user, "linked-issue")).toBe(2);
    expect(Buffer.byteLength(user, "utf8")).toBeLessThanOrEqual(4000);
    expect(r.llmCalled).toBe(1);
  });
  it("drops the issue block when the allowance is negative", async () => {
    // Allowance = 3200 − (2935 + 295 + ~100 + 145) < 0 → dropped (a zero-finding fixture would
    // silently truncate instead — the finding pins the allowance).
    const r = await runWithMocks({ maxPromptChars: 3200, diff: DIFF_2900, issueBody: "y".repeat(5000), prBody: "Fixes #7", scan: [SCAN_FINDING] });
    expect(r.prompts!.user).not.toContain("## Linked issue");
    expect(r.llmCalled).toBe(1);
  });
  it("drops the issue when the allowance is smaller than the marker", () => {
    // Allowance = 10 B, in [0, markerBytes): a marker-only cut (53 B) would
    // overflow and force a finding drop, so the issue block is dropped instead.
    const markerBytes = Buffer.byteLength(ISSUE_TRUNCATION_MARKER, "utf8");
    expect(10).toBeLessThan(markerBytes);
    const fast = [SCAN_FINDING];
    const promptText = "diff text";
    const nPrompt = neutralise(promptText);
    const noIssueBytes = Buffer.byteLength(buildMessages(fast, nPrompt, undefined, [], undefined, 0).user, "utf8");
    const overhead =
      Buffer.byteLength(buildMessages(fast, nPrompt, ISSUE_TRUNCATION_MARKER, [], undefined, 0).user, "utf8") -
      noIssueBytes -
      markerBytes;
    const r = budgetPrompt(fast, promptText, "hello issue", [], noIssueBytes + overhead + 10);
    expect(r.issueDropped).toBe(true);
    expect(r.issueBody).toBeUndefined();
    expect(r.findingsOmitted).toBe(0);
    expect(r.fast).toEqual(fast);
    const user = buildMessages(r.fast, r.promptText, r.issueBody, r.skipped, undefined, r.findingsOmitted).user;
    expect(user).not.toContain(ISSUE_TRUNCATION_MARKER);
    expect(Buffer.byteLength(user, "utf8")).toBeLessThanOrEqual(noIssueBytes + overhead + 10);
  });
  it("keeps a bare marker when the allowance equals the marker exactly", async () => {
    // Boundary of the drop test above: allowance == markerBytes keeps a bare
    // marker (no drop). Unit half mirrors the drop-test arithmetic.
    const markerBytes = Buffer.byteLength(ISSUE_TRUNCATION_MARKER, "utf8");
    expect(markerBytes).toBe(53);
    const fast = [SCAN_FINDING];
    const promptText = "diff text";
    const nPrompt = neutralise(promptText);
    const noIssueBytes = Buffer.byteLength(buildMessages(fast, nPrompt, undefined, [], undefined, 0).user, "utf8");
    const overhead =
      Buffer.byteLength(buildMessages(fast, nPrompt, ISSUE_TRUNCATION_MARKER, [], undefined, 0).user, "utf8") -
      noIssueBytes -
      markerBytes;
    const unitBudget = noIssueBytes + overhead + markerBytes; // allowance == markerBytes exactly
    const b = budgetPrompt(fast, promptText, "x".repeat(5000), [], unitBudget);
    expect(b.issueDropped).toBe(false);
    const unitUser = buildMessages(b.fast, b.promptText, b.issueBody, b.skipped, undefined, b.findingsOmitted).user;
    expect(unitUser).toContain(ISSUE_TRUNCATION_MARKER);
    expect(Buffer.byteLength(unitUser, "utf8")).toBeLessThanOrEqual(unitBudget);
    // Live half: size maxPromptChars from a full-budget probe so the live
    // allowance equals the marker exactly (the render is linear in the issue slot).
    const issue = "y".repeat(5000);
    const probe = await runWithMocks({ diff: DIFF_2900, issueBody: issue, prBody: "Fixes #7", scan: [SCAN_FINDING] });
    expect(probe.llmCalled).toBe(1);
    const budget =
      Buffer.byteLength(probe.prompts!.user, "utf8") -
      Buffer.byteLength(neutralise(issue), "utf8") +
      markerBytes;
    const r = await runWithMocks({ maxPromptChars: budget, diff: DIFF_2900, issueBody: issue, prBody: "Fixes #7", scan: [SCAN_FINDING] });
    expect(r.prompts!.user).toContain("## Linked issue");
    expect(r.prompts!.user).toContain(ISSUE_TRUNCATION_MARKER);
    expect(Buffer.byteLength(r.prompts!.user, "utf8")).toBeLessThanOrEqual(budget);
    expect(r.llmCalled).toBe(1);
  });
  it("drops whole findings with an exact omitted count", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ ...LLM_FINDING, rule: `r${i}` }));
    const r = await runWithMocks({ maxPromptChars: 1000, scan: many });
    // ^ 12 findings ≈ 1.2 KB + framing/diff ≈ 1.7 KB total > 1000 → drops ~7-8.
    const user = r.prompts!.user;
    const m = user.match(/Omitted (\d+) fast finding\(s\) to fit the prompt budget\./);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(0);
    const jsonLine = user.split("\n\n").find((l) => l.startsWith("["));
    const kept = JSON.parse(jsonLine!) as unknown[];
    expect(kept.length + Number(m![1])).toBe(many.length);
  });
  it("never cuts the diff, skipping instead", async () => {
    const r = await runWithMocks({ maxPromptChars: 1000, diff: DIFF_2000 });
    // ^ DIFF_2000: custom `diff` with a ~2,000 B hunk (the default 141 B DIFF never reaches any budget).
    expect(vi.mocked(core.warning).mock.calls.map(String).join("\n")).toMatch(/prompt \d+ exceeds max_prompt_chars 1000 after bounded cuts/);
    expect(r.llmCalled).toBe(0);
  });
  it("skips after cuts are exhausted", async () => {
    vi.mocked(core.warning).mockClear();
    const r = await runWithMocks({ maxPromptChars: 6000, maxDiffChars: 5500, diff: BIG_FIRST_PATCH, issueBody: "z".repeat(3000), prBody: "Fixes #7", scan: [SCAN_FINDING] });
    // ^ BIG_FIRST_PATCH: 5.2 KB file first + 25 tiny files `src/fixture-source-file-00.ts` …
    // `src/fixture-source-file-24.ts` (~29-char paths → ~33 B/note-line); test computes exact
    // Buffer.byteLength sums to show diff ≈ 5.2 KB, note ≈ 775 B, total > 6,000 with diff alone < 6,000.
    expect(vi.mocked(core.warning).mock.calls.map(String).join("\n")).toMatch(/prompt \d+ exceeds max_prompt_chars 6000 after bounded cuts/);
    expect(r.llmCalled).toBe(0);
  });
  it("pins the multibyte floor", async () => {
    vi.mocked(core.warning).mockClear();
    const r = await runWithMocks({ diff: CJK_PATCH });
    // ^ CJK_PATCH: 8 files × ~7,450 CJK units (each under PER_FILE_CAP 8000).
    expect(vi.mocked(core.warning).mock.calls.map(String).join("\n")).toMatch(/prompt \d+ exceeds max_prompt_chars 120000 after bounded cuts/);
    expect(r.llmCalled).toBe(0); // ~180 KB bytes > 120,000 default
  });
  it("records a prompt-budget skip in the step summary", async () => {
    const r = await runWithMocks({ maxPromptChars: 1000, diff: DIFF_2000 });
    expect(r.llmCalled).toBe(0);
    expect(readFileSync(r.summaryPath, "utf8")).toContain("LLM review skipped, gate uses fast findings only");
  });
  it("sanitizes evidence before the prompt", async () => {
    const r = await runWithMocks({ scan: [{ ...LLM_FINDING, message: "a\0b" }] });
    expect(r.prompts!.user).toContain('"message":"ab"'); // control strip is the discriminator (NUL never survives JSON.stringify)
    // The early fast-only findings.json write predates the slow path and preserves raw
    // evidence (pre-existing behavior, unchanged by the prompt-only copy): it pins that
    // the prompt-sanitization path did not alter what artifacts persist. Non-mutation of
    // `fast` itself holds by construction (`promptFast` copy) and was verified in review.
    expect(r.earlyFindingsRaw).toBeDefined();
    expect(r.earlyFindingsRaw!).toContain("a\\u0000b");
  });
  it("caps over-long finding fields in the prompt", async () => {
    const r = await runWithMocks({ scan: [{ ...LLM_FINDING, message: "y".repeat(3000) }] });
    const user = r.prompts!.user;
    expect(user).not.toContain("y".repeat(3000));
    expect(user).toContain("y".repeat(100)); // prefix present, capped per MSG_CAP
  });
  it("still posts omitted findings", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ ...LLM_FINDING, rule: `r${i}` }));
    const r = await runWithMocks({ maxPromptChars: 1000, scan: many });
    expect(r.posted).toBe(true);
    expect(r.reviews.at(-1)!.body).toContain("lupa: 13 finding(s)."); // 12 scan + 1 default LLM finding, all merged
    expect(JSON.stringify(r.reviews.at(-1)!)).toContain("r11"); // prompt-dropped rule still posts
  });
  it("renders the omission line on the agent path", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ ...LLM_FINDING, rule: `r${i}` }));
    const r = await runWithMocks({ maxPromptChars: 1000, llmAgent: true, scan: many });
    expect((r.agentConv as { user: string }).user).toContain("Omitted ");
  });
  it("treats whitespace-only issues as absent", async () => {
    const r = await runWithMocks({ issueBody: "   \n  ", prBody: "Fixes #7" });
    expect(r.prompts!.user).not.toContain("## Linked issue");
    expect(r.llmCalled).toBe(1);
  });
  it("logs the issue-dropped signal", async () => {
    const r = await runWithMocks({ maxPromptChars: 3200, diff: DIFF_2900, issueBody: "y".repeat(5000), prBody: "Fixes #7", scan: [SCAN_FINDING] });
    expect(vi.mocked(core.info).mock.calls.map(String).join("\n")).toContain("linked issue context dropped to fit the 3200-byte prompt budget");
    expect(r.llmCalled).toBe(1);
  });
  it("oversized findings.json throws the exact artifact-limit error", () => {
    const dir = scratch();
    writeFileSync(join(dir, "findings.json"), JSON.stringify([{ ...LLM_FINDING, message: "x".repeat(100) }]), "utf8");
    expect(() => readFindings(dir, 10)).toThrow("lupa: findings.json exceeds the artifact read limit (10 bytes)");
  });
});

describe("F15 publication funnel", () => {
  const cps = (s: string): number => Array.from(s).length;
  // src/a.ts with RIGHT lines 2..41 as additions (40 inline-eligible lines).
  const FUNNEL_DIFF_LINES = Array.from({ length: 40 }, (_, i) => `+const a${String(i + 2).padStart(2, "0")} = ${i + 2};`);
  const FUNNEL_DIFF = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,1 +1,41 @@
 const x = 1;
${FUNNEL_DIFF_LINES.join("\n")}
`;
  // 500 findings: 100 high (40 on-diff, 60 repo-level), 200 warning, 200 info.
  function funnelFindings(): Finding[] {
    const out: Finding[] = [];
    for (let i = 0; i < 40; i++) out.push({ severity: "high", file: "src/a.ts", line: i + 2, rule: `h-on-${i}`, message: `on-diff high ${i}` });
    for (let i = 0; i < 60; i++) out.push({ severity: "high", file: "", rule: `h-off-${i}`, message: `repo high ${i}` });
    for (let i = 0; i < 200; i++) out.push({ severity: "warning", file: "", rule: `w-${i}`, message: `repo warning ${i}` });
    for (let i = 0; i < 200; i++) out.push({ severity: "info", file: "", rule: `n-${i}`, message: `repo info ${i}` });
    return out;
  }
  const OMISSION_300 = "> Omitted: 300 finding(s) omitted to fit the 200-finding publication limit.";

  it("publishes the top 200 with inline cap 30, exact omission marker, and full-set gates", async () => {
    const r = await runWithMocks({ diff: FUNNEL_DIFF, scan: funnelFindings(), llm: [] });
    expect(r.posted).toBe(true);
    expect(r.reviews).toHaveLength(1);
    const payload = r.reviews[0]!;
    // Inline cap: the 40 on-diff highs post 30 inline (lines 2..31); lines 32..41 fold to the body.
    expect(payload.comments).toHaveLength(30);
    expect(payload.comments.map((c) => c.line)).toEqual(Array.from({ length: 30 }, (_, i) => i + 2));
    // Summary head shows the FULL count; the exact omission marker is present; no trunc-note on a fitting body.
    expect(payload.body).toContain("lupa: 500 finding(s).");
    expect(payload.body).toContain(OMISSION_300);
    expect(payload.body).not.toContain("> Note: review body truncated");
    // Folded excess keeps mapping order after the general section.
    expect(payload.body).toContain("- src/a.ts:32");
    expect(payload.body).toContain("- src/a.ts:41");
    expect(payload.body.indexOf("- src/a.ts:32")).toBeLessThan(payload.body.indexOf("- src/a.ts:41"));
    expect(payload.event).toBe("COMMENT");
    // Artifact keeps all 500; the summary head shows 500; gates saw the full set (warning level + highs => exit 2).
    expect(JSON.parse(readFileSync(join(r.artifactDir, "findings.json"), "utf8"))).toHaveLength(500);
    expect(readFileSync(r.summaryPath, "utf8")).toContain("lupa: 500 finding(s).");
    expect(r.exitCode).toBe(2);
  });

  it("truncates an over-long review body inside the char cap with the note last", async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      severity: "warning" as const,
      file: "",
      rule: `r${i}`,
      message: `evidence-${i}-` + "m".repeat(200),
    }));
    const r = await runWithMocks({ scan: many, llm: [], maxReviewBodyChars: 1000 });
    const body = r.reviews.at(-1)!.body;
    expect(cps(body)).toBeLessThanOrEqual(1000);
    expect(body.endsWith("> Note: review body truncated to the 1000-character limit.")).toBe(true);
    expect(body).toContain("lupa: 60 finding(s).");
  });

  it("dry-run logs posted counts plus omitted", async () => {
    const info = vi.mocked(core.info);
    info.mockClear();
    const many = Array.from({ length: 250 }, (_, i) => ({
      severity: "warning" as const,
      file: "",
      rule: `r${i}`,
      message: `m${i}`,
    }));
    const r = await runWithMocks({ postComment: false, scan: many, llm: [] });
    expect(r.posted).toBe(false);
    const dry = info.mock.calls.map((c) => String(c[0])).find((l) => l.includes("dry-run, nothing posted"));
    expect(dry).toBe(
      "post_comment is false: dry-run, nothing posted (would post event=COMMENT, inline=0, general=200, high=0, blocking=0, omitted=50)",
    );
  });

  it("caps the summary report at the remaining step-summary budget", async () => {
    const scan: Finding[] = [
      { severity: "warning", file: "src/a.ts", line: 2, rule: "r1", message: "first" },
      { severity: "warning", file: "src/a.ts", line: 2, rule: "r2", message: "second" },
      { severity: "warning", file: "src/a.ts", line: 2, rule: "r3", message: "third" },
    ];
    const r = await runWithMocks({ summaryPrefill: "P".repeat(1048000), scan, llm: [] });
    const text = readFileSync(r.summaryPath, "utf8");
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(1048576);
    expect(text).toContain("omitted because the report output limit was reached");
    expect(r.summaryWritten).toBe(true);
    expect(r.posted).toBe(true);
  });

  it("skips the summary write with a warning when nothing fits, and still posts", async () => {
    vi.mocked(core.warning).mockClear();
    const r = await runWithMocks({ summaryPrefill: "Q".repeat(1048570), llm: [] });
    expect(r.summaryWritten).toBe(false);
    expect(r.posted).toBe(true);
    const warnings = vi.mocked(core.warning).mock.calls.map((c) => String(c[0]));
    expect(warnings.some((l) => /summary.*skip/i.test(l))).toBe(true);
  });

  it("issue fallback publishes the retained set with the publication omission marker", async () => {
    const many = Array.from({ length: 250 }, (_, i) => ({
      severity: "warning" as const,
      file: "",
      rule: `r${i}`,
      message: `m${i}`,
    }));
    const r = await runWithMocks({ write403: true, issueFallback: true, scan: many, llm: [] });
    expect(r.posted).toBe(true);
    expect(r.issueComments).toHaveLength(1);
    const fallback = r.issueComments[0]!;
    expect(
      fallback.startsWith("> Omitted: 50 finding(s) omitted to fit the 200-finding publication limit.\n\nlupa: 200 finding(s)."),
    ).toBe(true);
  });

  it("forwards maxReviewBodyChars to the review gateway", async () => {
    const r = await runWithMocks({ maxReviewBodyChars: 12345, llm: [] });
    expect(r.reviewOpts?.maxBodyChars).toBe(12345);
    expect(r.reviewOpts?.canWrite).toBe(true);
  });

  it("Flow B applies the same publication funnel", async () => {
    const r = await runPrivileged({ findings: funnelFindings(), diff: FUNNEL_DIFF, maxFindings: 200 });
    expect(r.posted).toBe(true);
    const body = r.payloads.at(-1)!.body;
    expect(body).toContain("lupa: 500 finding(s).");
    expect(body).toContain(OMISSION_300);
    expect(r.payloads.at(-1)!.comments).toHaveLength(30);
    expect(r.exitCode).toBe(2);
  });

  it("Flow B rejects an oversized findings artifact loudly and posts nothing", async () => {
    // pr-meta.json (~167 B) passes the 300-byte cap; findings.json (~446 B) does not.
    // readFindings runs before publishReview, so the throw below precedes any post.
    const five = Array.from({ length: 5 }, () => ({ ...LLM_FINDING }));
    await expect(runPrivileged({ findings: five, maxArtifactBytes: 300 })).rejects.toThrow(
      "lupa: findings.json exceeds the artifact read limit (300 bytes)",
    );
  });
});

describe("dedup merge and flow wiring", () => {
  const CUT_DIFF = [
    "diff --git a/f.ts b/f.ts",
    "index 111..222 100644",
    "--- a/f.ts",
    "+++ b/f.ts",
    "@@ -1 +1 @@",
    "-a",
    "+b",
    "",
  ].join("\n");
  // Exact truncateDiff(filterForPrompt(parseDiffFiles(CUT_DIFF))) text: pinned by the probe below.
  const CUT_PROMPT_TEXT = "--- f.ts\n@@ -1 +1 @@\n-a\n+b\n";

  const sentKept = (user: string): unknown[] =>
    JSON.parse(user.split("\n\n").find((l) => l.startsWith("[")) as string) as unknown[];

  it("slowPath passes verdicts through with links converted to absolute indices and merges at publish", async () => {
    const scan: Finding[] = [
      { severity: "warning", file: "src/a.ts", line: 2, rule: "scan-a", message: "first evidence" },
      { severity: "warning", file: "src/a.ts", line: 2, rule: "scan-b", message: "second evidence" },
    ];
    const llm: Finding[] = [{ severity: "warning", file: "src/a.ts", line: 2, rule: "llm-c", message: "third evidence" }];
    const r = await runWithMocks({ scan, llm, llmVerdicts: { pairs: [[0, 1]], links: [[0, 0]], malformed: 0 } });
    expect(r.posted).toBe(true);
    // fast.length is 2 (no L0/L2 on the default DIFF), so response index 0 converts to absolute 2.
    expect(readPrMeta(r.artifactDir)!.verdicts).toEqual({ pairs: [[0, 1]], links: [[2, 0]], malformed: 0 });
    // All three merge into one inline comment; the summary head keeps the full pre-merge count.
    expect(r.reviews[0]!.comments).toHaveLength(1);
    expect(r.reviews[0]!.comments[0]!.body).toContain("scan-a+scan-b+llm-c");
    expect(r.reviews[0]!.body).toContain("lupa: 3 finding(s).");
    // The single-shot prompt carries ids and the verdict instructions.
    expect(r.prompts!.user).toContain('"id":0');
    expect(r.prompts!.system).toContain("duplicates");
  });

  it("slowPath warns on malformed verdicts and keeps every finding", async () => {
    vi.mocked(core.warning).mockClear();
    const scan: Finding[] = [{ severity: "warning", file: "src/a.ts", line: 2, rule: "scan-a", message: "kept" }];
    const r = await runWithMocks({ scan, llmVerdicts: { pairs: [], links: [], malformed: 2 } });
    expect(r.posted).toBe(true);
    expect(vi.mocked(core.warning).mock.calls.map((c) => String(c[0]))).toContain("lupa: ignored 2 malformed dedup verdict(s)");
    expect(r.reviews[0]!.body).toContain("lupa: 2 finding(s).");
    expect(JSON.stringify(r.reviews)).toContain("kept");
    expect(JSON.stringify(r.reviews)).toContain("llm message");
  });

  it("drops cut-tail verdicts with a warning and keeps every finding", async () => {
    const N = 5;
    const K = 3;
    const many: Finding[] = Array.from({ length: N }, (_, i) => ({
      severity: "warning" as const,
      file: "f.ts",
      rule: `cut-${i}`,
      message: `evidence ${i} ` + "x".repeat(200),
    }));
    // Premise guard: the CUT_DIFF prompt replication the budget math below depends on.
    const probe = await runWithMocks({ diff: CUT_DIFF, scan: many, llm: [] });
    expect(probe.prompts!.user).toContain(CUT_PROMPT_TEXT);
    // Measure serialized sizes in-test: largest budget whose single-shot (with-ids) render keeps exactly K.
    const fast = many.map(sanitizeFinding);
    const fullBytes = Buffer.byteLength(
      buildMessages(fast, CUT_PROMPT_TEXT, undefined, [], undefined, 0, { withIds: true }).user,
      "utf8",
    );
    let B = fullBytes;
    while (B > 0 && budgetPrompt(fast, CUT_PROMPT_TEXT, undefined, [], B, { withIds: true }).fast.length > K) B -= 1;
    expect(budgetPrompt(fast, CUT_PROMPT_TEXT, undefined, [], B, { withIds: true }).fast.length).toBe(K);
    vi.mocked(core.warning).mockClear();
    const r = await runWithMocks({
      diff: CUT_DIFF,
      scan: many,
      llm: [],
      maxPromptChars: B,
      llmVerdicts: { pairs: [[0, K]], links: [], malformed: 0 },
    });
    expect(r.llmCalled).toBe(1);
    // Sent index K was cut from the prompt (kept == K): the pair drops whole, counted as malformed.
    expect(vi.mocked(core.warning).mock.calls.map((c) => String(c[0]))).toContain("lupa: ignored 1 malformed dedup verdict(s)");
    expect(readPrMeta(r.artifactDir)!.verdicts).toEqual({ pairs: [], links: [], malformed: 1 });
    // Nothing merged, nothing lost: all N findings publish.
    expect(r.reviews[0]!.body).toContain(`lupa: ${N} finding(s).`);
    const dumped = JSON.stringify(r.reviews);
    for (let i = 0; i < N; i++) expect(dumped).toContain(`cut-${i}`);
  });

  it("empty verdicts publish byte-identical output to the unmerged funnel", async () => {
    const scan: Finding[] = [
      { severity: "warning", file: "src/a.ts", line: 2, rule: "scan-a", message: "first" },
      { severity: "warning", file: "src/a.ts", line: 2, rule: "scan-b", message: "second" },
    ];
    const llm: Finding[] = [{ severity: "warning", file: "src/a.ts", line: 2, rule: "llm-c", message: "third" }];
    const a = await runWithMocks({ scan, llm });
    const b = await runWithMocks({ scan, llm, llmVerdicts: { pairs: [], links: [], malformed: 0 } });
    expect(b.reviews).toEqual(a.reviews);
    expect(b.body).toBe(a.body);
  });

  it("Flow A pr-meta carries empty verdicts when no LLM ran", async () => {
    const r = await runWithMocks({ llmApiKey: "", scan: [{ ...LLM_FINDING, rule: "fast-only" }] });
    expect(r.findingsFrom).toBe("fastpath");
    expect(readPrMeta(r.artifactDir)!.verdicts).toEqual({ pairs: [], links: [], malformed: 0 });
  });

  it("merges before the funnel with gates on the blocking set, summary and high count on the full set; sarif matches merged", async () => {
    const scan: Finding[] = [
      { severity: "high", file: "src/a.ts", line: 2, rule: "h1", message: "high evidence" },
      { severity: "warning", file: "src/a.ts", line: 2, rule: "w1", message: "warning evidence" },
    ];
    const verdicts: DedupVerdicts = { pairs: [[0, 1]], links: [], malformed: 0 };
    const r = await runWithMocks({ scan, llm: [], llmVerdicts: verdicts, failLevel: "high" });
    expect(r.posted).toBe(true);
    expect(r.reviews[0]!.comments).toHaveLength(1);
    expect(r.reviews[0]!.comments[0]!.body).toContain("h1+w1");
    expect(r.reviews[0]!.comments[0]!.body).toContain("high evidence");
    expect(r.reviews[0]!.comments[0]!.body).toContain("warning evidence");
    expect(r.reviews[0]!.body).toContain("lupa: 2 finding(s).");
    expect(r.reviews[0]!.event).toBe("REQUEST_CHANGES");
    expect(r.exitCode).toBe(1);
    // Gate-equivalence: the unmerged twin gates identically.
    const plain = await runWithMocks({ scan, llm: [], failLevel: "high" });
    expect(plain.reviews[0]!.event).toBe(r.reviews[0]!.event);
    expect(plain.exitCode).toBe(r.exitCode);
    // SARIF alert count equals the merged count.
    const sarif = JSON.parse(readFileSync(join(r.artifactDir, "sarif.json"), "utf8")) as {
      runs: { results: { ruleId: string }[] }[];
    };
    expect(sarif.runs[0]!.results).toHaveLength(1);
    expect(sarif.runs[0]!.results[0]!.ruleId).toBe("h1+w1");
    // Dry-run counts the full set (high=1) with funnel positions from the merged set;
    // the single merged survivor is the blocking finding.
    const info = vi.mocked(core.info);
    info.mockClear();
    const dry = await runWithMocks({ scan, llm: [], llmVerdicts: verdicts, failLevel: "high", postComment: false });
    const line = info.mock.calls.map((c) => String(c[0])).find((l) => l.includes("dry-run, nothing posted"));
    expect(line).toBe(
      "post_comment is false: dry-run, nothing posted (would post event=REQUEST_CHANGES, inline=1, general=0, high=1, blocking=1, omitted=0)",
    );
    expect(dry.body).toBeUndefined();
  });

  it("F15 omission marker counts the post-merge top-N cut", async () => {
    const scan: Finding[] = Array.from({ length: 4 }, (_, i) => ({
      severity: "warning" as const,
      file: "",
      rule: `m${i}`,
      message: `repo evidence ${i}`,
    }));
    const r = await runWithMocks({ scan, llm: [], llmVerdicts: { pairs: [[0, 1]], links: [], malformed: 0 }, maxFindings: 2 });
    // Merged 4 -> 3, top-2 retained: omitted is 3 - 2 = 1, never the naive 4 - 2 = 2.
    expect(r.reviews[0]!.body).toContain("lupa: 4 finding(s).");
    expect(r.reviews[0]!.body).toContain("> Omitted: 1 finding(s) omitted to fit the 2-finding publication limit.");
    expect(r.reviews[0]!.body).not.toContain("> Omitted: 2 finding(s)");
  });

  it("publishReview warns the exact unmergeable-verdict string and still publishes every finding", async () => {
    vi.mocked(core.warning).mockClear();
    const scan: Finding[] = [
      { severity: "warning", file: "src/a.ts", line: 2, rule: "scan-a", message: "first evidence" },
      { severity: "warning", file: "src/b.ts", line: 2, rule: "scan-b", message: "second evidence" },
    ];
    const r = await runWithMocks({ scan, llm: [], llmVerdicts: { pairs: [[0, 1]], links: [], malformed: 0 } });
    expect(r.posted).toBe(true);
    expect(vi.mocked(core.warning).mock.calls.map((c) => String(c[0]))).toContain(
      "lupa: ignored 1 unmergeable dedup verdict(s)",
    );
    expect(r.reviews[0]!.body).toContain("lupa: 2 finding(s).");
    const dumped = JSON.stringify(r.reviews);
    expect(dumped).toContain("scan-a");
    expect(dumped).toContain("scan-b");
  });

  it("Flow B merges the canary via pr-meta verdicts; a missing key posts unmerged", async () => {
    const findings: Finding[] = [
      { severity: "high", file: "src/a.ts", line: 2, rule: "github-pat", message: "Artifact: leak [REDACTED]" },
      { severity: "warning", file: "src/a.ts", line: 2, rule: "github-pat", message: "detected secret [REDACTED]" },
    ];
    const merged = await runPrivileged({ findings, metaVerdicts: { pairs: [[0, 1]], links: [], malformed: 0 } });
    expect(merged.posted).toBe(true);
    expect(merged.payloads[0]!.comments).toHaveLength(1);
    expect(merged.payloads[0]!.comments[0]!.body).toContain("**high**");
    expect(merged.payloads[0]!.comments[0]!.body).toContain("[github-pat]");
    expect(merged.payloads[0]!.comments[0]!.body).toContain("[REDACTED]");
    const plain = await runPrivileged({ findings });
    expect(plain.posted).toBe(true);
    expect(plain.payloads[0]!.comments).toHaveLength(2);
  });

  it("agent duplicates stay unmerged with byte-identical prompts at the cut", async () => {
    const llm: Finding[] = [
      { severity: "warning", file: "src/a.ts", line: 2, rule: "dup-a", message: "same evidence a" },
      { severity: "warning", file: "src/a.ts", line: 2, rule: "dup-b", message: "same evidence b" },
    ];
    const r = await runWithMocks({ llmAgent: true, scan: [], llm });
    expect(r.posted).toBe(true);
    expect(r.agentCalled).toBe(1);
    expect(r.reviews[0]!.comments).toHaveLength(2);
    expect((r.agentConv as { user: string }).user).not.toContain('"id"');
    // Same findings kept as base at the cut: the agent render measures exactly the no-ids render.
    const many: Finding[] = Array.from({ length: 6 }, (_, i) => ({
      severity: "warning" as const,
      file: "f.ts",
      rule: `abase-${i}`,
      message: `agent evidence ${i} ` + "y".repeat(200),
    }));
    const fast = many.map(sanitizeFinding);
    const fullBytes = Buffer.byteLength(buildMessages(fast, CUT_PROMPT_TEXT, undefined, [], undefined, 0).user, "utf8");
    let B = fullBytes;
    while (B > 0 && budgetPrompt(fast, CUT_PROMPT_TEXT, undefined, [], B).fast.length >= many.length) B -= 1;
    const expected = budgetPrompt(fast, CUT_PROMPT_TEXT, undefined, [], B);
    expect(expected.fast.length).toBeLessThan(many.length);
    const cut = await runWithMocks({ diff: CUT_DIFF, maxPromptChars: B, llmAgent: true, scan: many, llm: [] });
    expect(sentKept((cut.agentConv as { user: string }).user)).toHaveLength(expected.fast.length);
    expect((cut.agentConv as { user: string }).user).not.toContain('"id"');
  });

  it("no-LLM runs note the skipped dedup exactly", async () => {
    const info = vi.mocked(core.info);
    info.mockClear();
    const r = await runWithMocks({ llmApiKey: "" });
    expect(r.posted).toBe(true);
    expect(info.mock.calls.map((c) => String(c[0]))).toContain(
      "lupa: dedup skipped (slow path unavailable); scanner findings published unmerged",
    );
    expect(readFileSync(r.summaryPath, "utf8")).toContain(
      "lupa: dedup skipped (slow path unavailable); scanner findings published unmerged",
    );
  });

  it("budgetPrompt measures with ID bytes when asked and exactly as base otherwise", () => {
    const fast: Finding[] = Array.from({ length: 3 }, (_, i) => ({
      severity: "warning" as const,
      file: "src/a.ts",
      line: 2,
      rule: `r${i}`,
      message: "m".repeat(200),
    }));
    const text = "diff text";
    expect(budgetPrompt(fast, text, undefined, [], 100000, { withIds: false })).toEqual(
      budgetPrompt(fast, text, undefined, [], 100000),
    );
    // Budget sized to the exact without-ids render: without-ids keeps all, with-ids must cut.
    const fullBytes = Buffer.byteLength(buildMessages(fast, neutralise(text), undefined, [], undefined, 0).user, "utf8");
    expect(budgetPrompt(fast, text, undefined, [], fullBytes).fast).toHaveLength(fast.length);
    const cut = budgetPrompt(fast, text, undefined, [], fullBytes, { withIds: true });
    expect(cut.fast.length).toBeLessThan(fast.length);
    expect(cut.findingsOmitted).toBeGreaterThan(0);
  });
});

describe("finding provenance rendering (Q04)", () => {
  it("toSarif carries source and confidence independently, omits properties when both absent", () => {
    const base: Finding = { severity: "warning", file: "src/a.ts", line: 2, rule: "r", message: "m" };
    const full = toSarif([{ ...base, source: "semgrep", confidence: 90 }]) as {
      runs: Array<{ results: Array<{ properties?: unknown; message: { text: string } }> }>;
    };
    expect(full.runs[0].results[0].properties).toEqual({ source: "semgrep", confidence: 90 });
    expect(full.runs[0].results[0].message).toEqual({ text: "m" });
    const confOnly = toSarif([{ ...base, confidence: 50 }]) as {
      runs: Array<{ results: Array<{ properties?: unknown }> }>;
    };
    expect(confOnly.runs[0].results[0].properties).toEqual({ confidence: 50 });
    const srcOnly = toSarif([{ ...base, source: "fastpath" }]) as {
      runs: Array<{ results: Array<{ properties?: unknown }> }>;
    };
    expect(srcOnly.runs[0].results[0].properties).toEqual({ source: "fastpath" });
    const neither = toSarif([base]) as {
      runs: Array<{ results: Array<Record<string, unknown>> }>;
    };
    expect("properties" in neither.runs[0].results[0]).toBe(false);
  });

  it("findings.json round-trips provenance through the artifact", () => {
    const dir = scratch();
    const findings: Finding[] = [
      { ...LLM_FINDING, source: "semgrep", confidence: 90, evidence: { analyzer: "semgrep" } },
      { ...LLM_FINDING, confidence: 0 },
    ];
    writeFileSync(join(dir, "findings.json"), JSON.stringify(findings), "utf8");
    expect(readFindings(dir)).toEqual(findings);
  });

  it("no-LLM run renders scanner provenance inline and in the summary", async () => {
    const scan: Finding = { ...LLM_FINDING, source: "semgrep", confidence: 90, evidence: { analyzer: "semgrep" } };
    const r = await runWithMocks({ llmApiKey: "", scan: [scan] });
    expect(r.reviews).toHaveLength(1);
    expect(r.reviews[0].comments[0].body).toContain("`src:semgrep · conf 90`");
    const summary = readFileSync(r.summaryPath, "utf8");
    expect(summary).toContain("- Source:");
    expect(summary).toContain("semgrep");
    expect(summary).toContain("- Confidence:");
    expect(summary).toContain("- Evidence:");
  });

  it("agent run carries no provenance anywhere", async () => {
    const r = await runWithMocks({ llmAgent: true, llm: [{ ...LLM_FINDING }] });
    expect(r.agentCalled).toBe(1);
    expect(r.body ?? "").not.toContain("`src:");
    expect(r.body ?? "").not.toContain("`conf");
    const summary = readFileSync(r.summaryPath, "utf8");
    expect(summary).not.toContain("- Source:");
    expect(summary).not.toContain("- Confidence:");
    expect(summary).not.toContain("- Evidence:");
  });

  it("provenanced high and warning findings gate identically", async () => {
    const high: Finding = { severity: "high", file: "src/a.ts", line: 2, rule: "r", message: "h", source: "fastpath", confidence: 50 };
    const warn: Finding = { ...LLM_FINDING, source: "llm", confidence: 70 };
    const gated = await runWithMocks({ failLevel: "high", llm: [high, warn] });
    expect(gated.exitCode).toBe(1);
    expect(gated.reviews[0].event).toBe("REQUEST_CHANGES");
    const warned = await runWithMocks({ failLevel: "warning", llm: [warn] });
    expect(warned.exitCode).toBe(2);
    expect(warned.reviews[0].event).toBe("COMMENT");
  });

  it("publication counts are unchanged with provenance present", async () => {
    const a: Finding = { ...LLM_FINDING, source: "semgrep", confidence: 90 };
    const b: Finding = { severity: "warning", file: "src/b.ts", rule: "r2", message: "second", source: "llm", confidence: 70 };
    const r = await runWithMocks({ maxFindings: 1, llm: [a, b] });
    expect(r.body ?? "").toContain("> Omitted: 1 finding(s) omitted to fit the 1-finding publication limit.");
  });

  it("redacted secret appears on neither the fallback nor the SARIF surface", () => {
    const secret = "sk-secret-1";
    const redacted = redactFindings(
      [
        {
          severity: "warning",
          file: "src/a.ts",
          line: 2,
          rule: "r",
          message: `saw ${secret} in code`,
          suggestion: `rotate ${secret} now`,
          source: "semgrep",
          confidence: 90,
          evidence: { analyzer: `tool ${secret}`, snippet: `token ${secret} here` },
        },
      ],
      [secret],
    );
    const fallback = buildFallbackReport(redacted);
    expect(fallback).not.toContain(secret);
    expect(fallback).toContain("[REDACTED]");
    expect(JSON.stringify(toSarif(redacted))).not.toContain(secret);
  });
});
