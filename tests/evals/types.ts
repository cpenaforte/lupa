import type { Analysis, Gateway, Outcome, RunEnv } from "../../src/main.js";
import type { ActionInputs } from "../../src/inputs.js";
import type { PrInfo } from "../../src/application/contracts.js";
import type { Finding } from "../../src/fastpath.js";
import type { ReviewPayload } from "../../src/review.js";
import type { AnalysisAssessment, AnalysisStatus, StageResult } from "../../src/domain/assessment.js";
import type { LlmResult, DedupVerdicts } from "../../src/llm/types.js";
import type { ReviewThread } from "../../src/github.js";

export interface EvalExecution {
  scannerStages: StageResult[];
  l2Stages: StageResult[];
  model: LlmResult["execution"];
}

export type EvalPublicationExpectation =
  | { kind: "review"; payload: ReviewPayload }
  | { kind: "issue-comment"; body: string }
  | { kind: "none" };

export interface EvalCase {
  id: string;
  categories: readonly EvalCategory[];
  syntheticRationale: string;
  patchFixture: string;
  repoFiles?: Record<string, string>;
  /** Extra files staged into artifactDir before run() (e.g. Flow B's pr-meta.json/findings.json). */
  artifactFiles?: Record<string, string>;
  /** Replaces the harness default pull_request/synchronize event. */
  eventOverride?: { eventName: string; payload: unknown };
  inputOverrides?: Partial<ActionInputs>;
  envOverrides?: Partial<Pick<RunEnv, "tokenType" | "issueFallback">>;
  fakeGatewayMode?: "normal" | "headMovesBeforePost" | "isFork" | "refusedReview" | "staleOnPost" | "flowBPrs";
  scannerFindings?: Finding[];
  /** Scripted health is independent of findings, including zero-finding runs. */
  execution: EvalExecution;
  reviewThreads?: ReviewThread[];
  actor?: string | null;
  livePr?: Partial<PrInfo>;
  verdicts?: DedupVerdicts;
  /** Runs a real read-only tool through the orchestration-supplied ToolContext. */
  agentTool?: { name: string; args: unknown };
  l2Findings?: Finding[];
  llmFindings?: Finding[];
  /** When set, callByStyle/callWithProbe return { ok: false, reason, detail } instead. */
  llmError?: { reason: string; detail: string };
  expected: {
    analysisStatus: AnalysisStatus;
    coverage: Partial<AnalysisAssessment["coverage"]>;
    promptDiffSnippet: string;
    findings: Finding[];
    exitCode: number;
    summary: string;
    publication: EvalPublicationExpectation;
  };
}

export type EvalCategory =
  | "positive"
  | "safe-negative"
  | "repaired"
  | "deletion"
  | "force-push"
  | "fork-readonly"
  | "large-diff"
  | "unchanged-baseline"
  | "flow-b"
  | "dry-run"
  | "non-trigger"
  | "issue-fallback"
  | "scanner-merge"
  | "high-gate"
  | "llm-failure"
  | "stale-post";

export interface EvalPublication {
  path: "review" | "issue-comment";
  pr: number;
  payload?: ReviewPayload;
  body?: string;
}

export interface EvalRun {
  outcome: Outcome;
  prompts: { system: string; user: string };
  gatewayCalls: Array<{ method: string; args: unknown[] }>;
  publications: EvalPublication[];
  findings: Finding[];
  summary: string;
  artifactDir: string;
  workDir: string;
  analysisCalls: Array<{ method: keyof Analysis; args: unknown[] }>;
  fakeInterfaces: { gateway: Gateway; analysis: Analysis };
}
