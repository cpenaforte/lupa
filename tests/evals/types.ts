import type { Analysis, Gateway, Outcome, RunEnv } from "../../src/main.js";
import type { ActionInputs } from "../../src/inputs.js";
import type { Finding } from "../../src/fastpath.js";
import type { ReviewPayload } from "../../src/review.js";

export type EvalPublicationExpectation =
  | { kind: "review"; payload: ReviewPayload }
  | { kind: "issue-comment"; body: string }
  | { kind: "none" };

export interface EvalCase {
  id: string;
  categories: readonly string[];
  syntheticRationale: string;
  patchFixture: string;
  repoFiles?: Record<string, string>;
  inputOverrides?: Partial<ActionInputs>;
  envOverrides?: Partial<Pick<RunEnv, "tokenIsApp" | "issueFallback">>;
  fakeGatewayMode?: "normal" | "readonly-fork" | "stale-head";
  scannerFindings?: Finding[];
  l2Findings?: Finding[];
  llmFindings?: Finding[];
  expected: {
    promptDiffSnippet: string;
    findings: Finding[];
    exitCode: number;
    summary: string;
    publication: EvalPublicationExpectation;
  };
}

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
