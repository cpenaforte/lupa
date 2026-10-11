import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ActionInputs } from "../../src/inputs.js";
import type { Analysis, Deps, Gateway, PrInfo, RunEnv } from "../../src/main.js";
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
    postComment: true,
    timeoutSeconds: 1,
    prNumber: null,
    llmAgent: false,
    llmAgentMaxTurns: 2,
    llmAgentMaxSeconds: 1,
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
      publications.push({ path: "review", pr, payload });
    },
    async createIssueComment(pr, body) {
      gatewayCalls.push({ method: "createIssueComment", args: [pr, body] });
      publications.push({ path: "issue-comment", pr, body });
    },
  };
  const llm = async (method: "callByStyle" | "callWithProbe", args: unknown[]) => {
    analysisCalls.push({ method, args });
    const messages = method === "callByStyle"
      ? args[1] as { system: string; user: string }
      : args[4] as { system: string; user: string };
    prompts.system = messages.system;
    prompts.user = messages.user;
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
    eventName: "pull_request",
    payload: { action: "synchronize", pull_request: { number: PR_NUMBER } },
    inputs: { ...defaultInputs(), ...testCase.inputOverrides },
    workDir,
    artifactDir,
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    tokenIsApp: false,
    issueFallback: false,
    summaryPath,
    ...testCase.envOverrides,
  };
  const outcome = await bundled.run(env, { gh: gateway, analysis } satisfies Deps);
  const findings = JSON.parse(readFileSync(join(artifactDir, "findings.json"), "utf8")) as EvalRun["findings"];
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
