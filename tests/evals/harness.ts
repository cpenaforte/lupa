import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ActionInputs } from "../../src/inputs.js";
import {
  DEFAULT_MAX_ARTIFACT_BYTES,
  DEFAULT_MAX_FINDINGS,
  DEFAULT_MAX_INLINE_COMMENTS,
  DEFAULT_MAX_REVIEW_BODY_CHARS,
} from "../../src/inputs.js";
import { ReadonlyTokenError, StaleHeadError } from "../../src/github.js";
import type { Analysis, Deps, Gateway, PrInfo, RunEnv } from "../../src/main.js";
import type { LlmResult } from "../../src/llm.js";
import type { EvalCase, EvalPublication, EvalRun } from "./types.js";

const BASE_SHA = "b".repeat(40);
const HEAD_SHA = "a".repeat(40);
const PR_NUMBER = 17;
const fixtureDir = new URL("../fixtures/evals/", import.meta.url);
const scratchRoots: string[] = [];

export function cleanupEvalRuns(): void {
  for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true });
}

function defaultInputs(): ActionInputs {
  return {
    githubToken: "synthetic-github-token",
    llmProvider: "openai",
    llmBaseUrl: "https://provider.invalid/v1",
    llmApiStyle: "openai-chat",
    llmPath: "",
    llmModel: "synthetic-model",
    llmApiKey: "synthetic-fixture-key",
    llmMaxTokens: 128,
    failLevel: "warning",
    maxDiffChars: 60000,
    maxPromptChars: 120000,
    maxFindings: DEFAULT_MAX_FINDINGS,
    maxInlineComments: DEFAULT_MAX_INLINE_COMMENTS,
    maxReviewBodyChars: DEFAULT_MAX_REVIEW_BODY_CHARS,
    maxArtifactBytes: DEFAULT_MAX_ARTIFACT_BYTES,
    postComment: true,
    timeoutSeconds: 1,
    prNumber: null,
    llmAgent: false,
    llmAgentMaxTurns: 2,
    llmAgentMaxSeconds: 1,
  };
}

/**
 * `dist/index.js` instantiates its own ReadonlyTokenError/StaleHeadError classes, unreachable
 * from the test realm (the bundle exports only run/main/readRunEnv/...), so the harness's
 * src-realm fakes would fail publishReview's `instanceof` checks. `instanceof` resolves
 * @@hasInstance through the shared native Error object the bundle's classes extend, so this
 * installs a scoped own-property bridge: while bundled.run() executes, an error whose class
 * name matches one of the two bundle error classes is recognized as an instance; every other
 * check delegates to the ordinary builtin, preserving default semantics. Removed in `finally`.
 */
const BUNDLE_ERROR_NAMES: ReadonlySet<string> = new Set(["ReadonlyTokenError", "StaleHeadError"]);
const ordinaryHasInstance = Function.prototype[Symbol.hasInstance];
let bridgeInstalled = false;
function bundleErrorHasInstance(this: unknown, e: unknown): boolean {
  if (
    typeof this === "function" &&
    this !== Error &&
    e instanceof Error &&
    (e as Error).name === (this as { name: string }).name &&
    BUNDLE_ERROR_NAMES.has((e as Error).name)
  ) {
    return true;
  }
  return ordinaryHasInstance.call(this as Function, e);
}
function bridgeBundleErrors(): () => void {
  // MUST NOT be used re-entrantly: the bridge mutates the shared global Error object, so a
  // second concurrent runBundleEval (e.g. via Promise.all / it.concurrent) would see the first
  // run's bridge and corrupt its restore. Sequential use is safe (installed here, removed in
  // runBundleEval's finally). The flag below turns a future re-entrant caller into a loud error.
  if (bridgeInstalled) throw new Error("lupa eval harness: bridgeBundleErrors entered re-entrantly");
  bridgeInstalled = true;
  const prior = Object.getOwnPropertyDescriptor(Error, Symbol.hasInstance);
  Object.defineProperty(Error, Symbol.hasInstance, { configurable: true, value: bundleErrorHasInstance });
  return () => {
    if (prior === undefined) Reflect.deleteProperty(Error, Symbol.hasInstance);
    else Object.defineProperty(Error, Symbol.hasInstance, prior);
    bridgeInstalled = false;
  };
}

export async function runBundleEval(testCase: EvalCase): Promise<EvalRun> {
  const root = mkdtempSync(join(tmpdir(), "lupa-eval-"));
  scratchRoots.push(root);
  const workDir = join(root, "work");
  const artifactDir = join(root, "artifacts");
  const summaryPath = join(root, "step-summary.md");
  mkdirSync(workDir, { recursive: true });
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(summaryPath, "", "utf8");
  copyFileSync(new URL(testCase.patchFixture, fixtureDir), join(artifactDir, "diff.patch"));
  for (const [name, contents] of Object.entries(testCase.artifactFiles ?? {})) {
    writeFileSync(join(artifactDir, name), contents, "utf8");
  }
  for (const [name, contents] of Object.entries(testCase.repoFiles ?? {})) {
    const path = join(workDir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, "utf8");
  }

  const bundlePath = resolve(process.cwd(), "dist/index.js");
  const bundleUrl = pathToFileURL(bundlePath);
  bundleUrl.searchParams.set("synthetic-eval", testCase.id);
  const bundled = (await import(bundleUrl.href)) as typeof import("../../src/main.js");
  const prompts = { system: "", user: "" };
  const gatewayCalls: Array<{ method: string; args: unknown[] }> = [];
  const publications: EvalPublication[] = [];
  const analysisCalls: Array<{ method: keyof Analysis; args: unknown[] }> = [];
  let getPrCount = 0;
  const normalPr: PrInfo = {
    body: "",
    headSha: HEAD_SHA,
    headRepo: "synthetic-owner/synthetic-repo",
    headRef: "synthetic-branch",
    isFork: testCase.fakeGatewayMode === "isFork",
  };
  const gateway: Gateway = {
    async getPr(pr) {
      gatewayCalls.push({ method: "getPr", args: [pr] });
      getPrCount += 1;
      if (testCase.fakeGatewayMode === "headMovesBeforePost" && getPrCount > 1)
        return { ...normalPr, headSha: "c".repeat(40) };
      return normalPr;
    },
    async findPrsByHead(headRepo, headRef) {
      gatewayCalls.push({ method: "findPrsByHead", args: [headRepo, headRef] });
      if (testCase.fakeGatewayMode === "flowBPrs") return [PR_NUMBER];
      return [];
    },
    async getIssueBody(issue) {
      gatewayCalls.push({ method: "getIssueBody", args: [issue] });
      return "";
    },
    async getRepoSize(owner, repo) {
      gatewayCalls.push({ method: "getRepoSize", args: [owner, repo] });
      return 0;
    },
    async createReview(pr, payload) {
      gatewayCalls.push({ method: "createReview", args: [pr, payload] });
      if (testCase.fakeGatewayMode === "refusedReview") throw new ReadonlyTokenError("refused", 403);
      if (testCase.fakeGatewayMode === "staleOnPost") throw new StaleHeadError("a".repeat(40), "c".repeat(40));
      publications.push({ path: "review", pr, payload });
    },
    async createIssueComment(pr, body) {
      gatewayCalls.push({ method: "createIssueComment", args: [pr, body] });
      publications.push({ path: "issue-comment", pr, body });
    },
  };
  const llm = async (method: "callByStyle" | "callWithProbe", args: unknown[]): Promise<LlmResult> => {
    analysisCalls.push({ method, args });
    const messages = method === "callByStyle"
      ? args[1] as { system: string; user: string }
      : args[4] as { system: string; user: string };
    prompts.system = messages.system;
    prompts.user = messages.user;
    if (testCase.llmError !== undefined) {
      const error = testCase.llmError;
      return { ok: false as const, reason: error.reason, detail: error.detail } as LlmResult;
    }
    return { ok: true as const, findings: [...(testCase.llmFindings ?? [])] };
  };
  const analysis: Analysis = {
    async runScanners(options) {
      analysisCalls.push({ method: "runScanners", args: [options] });
      return { findings: [...(testCase.scannerFindings ?? [])] };
    },
    async runL2(dir) {
      analysisCalls.push({ method: "runL2", args: [dir] });
      return [...(testCase.l2Findings ?? [])];
    },
    async ensureOllama(...args) {
      analysisCalls.push({ method: "ensureOllama", args });
    },
    async checkModelListed(...args) {
      analysisCalls.push({ method: "checkModelListed", args });
      return { status: "listed" };
    },
    callByStyle: (ep, messages, options) => llm("callByStyle", [ep, messages, options]),
    callWithProbe: (...args) => llm("callWithProbe", args),
    async callByStyleAgent(...args) {
      analysisCalls.push({ method: "callByStyleAgent", args });
      return { ok: true, findings: [...(testCase.llmFindings ?? [])] };
    },
    async callWithProbeAgent(...args) {
      analysisCalls.push({ method: "callWithProbeAgent", args });
      return { ok: true, findings: [...(testCase.llmFindings ?? [])] };
    },
  };
  const env: RunEnv = {
    eventName: testCase.eventOverride?.eventName ?? "pull_request",
    payload: (testCase.eventOverride?.payload ?? { action: "synchronize", pull_request: { number: PR_NUMBER } }) as Record<string, unknown>,
    inputs: { ...defaultInputs(), ...testCase.inputOverrides },
    workDir,
    artifactDir,
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    tokenType: "github-token",
    issueFallback: false,
    summaryPath,
    ...testCase.envOverrides,
  };
  const restoreHasInstance = bridgeBundleErrors();
  let outcome: Awaited<ReturnType<typeof bundled.run>>;
  try {
    outcome = await bundled.run(env, { gh: gateway, analysis } satisfies Deps);
  } finally {
    restoreHasInstance();
  }
  const findingsPath = join(artifactDir, "findings.json");
  const findings = existsSync(findingsPath)
    ? (JSON.parse(readFileSync(findingsPath, "utf8")) as EvalRun["findings"])
    : [];
  return {
    outcome,
    prompts,
    gatewayCalls,
    publications,
    findings,
    summary: readFileSync(summaryPath, "utf8").trimEnd(),
    artifactDir,
    workDir,
    analysisCalls,
    fakeInterfaces: { gateway, analysis },
  };
}
