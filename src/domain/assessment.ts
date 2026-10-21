export type AnalysisPolicy = "advisory" | "required";
export type AnalysisStatus = "complete" | "incomplete" | "unsupported" | "failed" | "skipped";

export interface StageResult {
  stage: string;
  status: "ok" | "failed" | "skipped" | "unsupported";
  applicable: boolean;
  required: boolean;
  reason?: string;
}

export interface CoverageIssue {
  code: string;
  file?: string;
  message: string;
}

export interface AnalysisAssessment {
  version: 1;
  baseSha: string;
  headSha: string;
  policy: AnalysisPolicy;
  scope: "deterministic" | "semantic";
  status: AnalysisStatus;
  stages: StageResult[];
  /** Prompt-eligible semantic units; unsupported filtered paths are separate issues. */
  coverage: {
    filesTotal: number;
    hunksTotal: number;
    /** A file counts only when all its eligible hunks reached a successful model execution. */
    filesReviewed: number;
    hunksReviewed: number;
    issues: CoverageIssue[];
    issuesOmitted: number;
  };
}

/** Reduce recorded execution evidence. Producers must explicitly record every required stage. */
export function assessAnalysis(input: {
  triggered: boolean;
  scope: AnalysisAssessment["scope"];
  stages: StageResult[];
  coverage: AnalysisAssessment["coverage"];
}): AnalysisStatus {
  if (!input.triggered) return "skipped";
  const required = input.stages.filter((stage) => stage.applicable && stage.required);
  if (required.some((stage) => stage.status === "failed")) return "failed";
  if (required.some((stage) => stage.status === "unsupported")) return "unsupported";
  const { coverage } = input;
  // Codes are descriptive, not a classification protocol: unsupported evidence needs a stage.
  if (
    required.some((stage) => stage.status === "skipped") ||
    coverage.issues.length > 0 || coverage.issuesOmitted > 0 ||
    (input.scope === "semantic" && (
      coverage.filesReviewed < coverage.filesTotal || coverage.hunksReviewed < coverage.hunksTotal
    ))
  ) return "incomplete";
  return "complete";
}

/** Required completeness is an independent gate; omitted legacy policy means advisory. */
export function assessmentExit(policy: AnalysisPolicy = "advisory", status: AnalysisStatus, severityExit: number): number {
  if (status === "skipped") return 0;
  if (policy === "required" && status !== "complete") return 3;
  return severityExit;
}
