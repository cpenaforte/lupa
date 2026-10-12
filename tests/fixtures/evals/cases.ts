import type { EvalCase } from "../../evals/types.js";

export const EVAL_CORPUS_VERSION = 1;

export const authzFinding = {
  severity: "warning",
  file: "src/auth.ts",
  line: 2,
  rule: "authorization-missing",
  message: "The new path returns a record without checking that the caller may read it.",
} as const;

export const highFinding = {
  severity: "high",
  file: "src/auth.ts",
  line: 2,
  rule: "missing-auth",
  message: "The changed check runs without any authentication.",
} as const;

const commandFinding = {
  severity: "warning",
  file: "src/archive.ts",
  line: 2,
  rule: "shell-argument-interpolation",
  message: "Interpolating an archive name into a shell command can allow command injection.",
} as const;

const cleanPayload = {
  commit_id: "a".repeat(40),
  body: "lupa: no findings.",
  event: "COMMENT" as const,
  comments: [],
};

const authzSummary = [
  "lupa: 1 finding(s).",
  "",
  "### Finding 1",
  "",
  "- Severity: warning",
  "- Location:",
  "\x60\x60\x60text",
  "src/auth.ts:2",
  "\x60\x60\x60",
  "- Rule:",
  "\x60\x60\x60text",
  "authorization-missing",
  "\x60\x60\x60",
  "- Message/evidence:",
  "\x60\x60\x60text",
  authzFinding.message,
  "\x60\x60\x60",
  "- Suggested remediation (advice only):",
  "\x60\x60\x60text",
  "No remediation supplied",
  "\x60\x60\x60",
].join("\n");

const commandSummary = [
  "lupa: 1 finding(s).",
  "",
  "### Finding 1",
  "",
  "- Severity: warning",
  "- Location:",
  "\x60\x60\x60text",
  "src/archive.ts:2",
  "\x60\x60\x60",
  "- Rule:",
  "\x60\x60\x60text",
  "shell-argument-interpolation",
  "\x60\x60\x60",
  "- Message/evidence:",
  "\x60\x60\x60text",
  commandFinding.message,
  "\x60\x60\x60",
  "- Suggested remediation (advice only):",
  "\x60\x60\x60text",
  "No remediation supplied",
  "\x60\x60\x60",
].join("\n");

const deletionFinding = {
  severity: "warning", file: "src/legacy.ts", line: 3, rule: "removed-unsafe-branch",
  message: "The removed legacy branch bypassed validation.",
} as const;
const forceFinding = {
  severity: "warning", file: "src/force.ts", line: 2, rule: "unchecked-state-transition",
  message: "The changed transition accepts an unchecked state.",
} as const;
const forkFinding = {
  severity: "warning", file: "src/fork.ts", line: 2, rule: "unsafe-default",
  message: "The new default enables an unsafe mode.",
} as const;
const forkL2Skipped = {
  severity: "info", file: "", rule: "l2-skipped",
  message: "L2 native toolchains were not executed: fork PR with secrets in scope. Semgrep, gitleaks and trivy still ran.",
} as const;

const mergeL2Note = {
  severity: "info", file: "", rule: "l2-note",
  message: "Synthetic L2 note.",
} as const;

function summaryForMany(findings: readonly { severity: string; file: string; line?: number; rule: string; message: string }[]): string {
  return [`lupa: ${findings.length} finding(s).`, ...findings.flatMap((finding, index) => [
    "", `### Finding ${index + 1}`, "", `- Severity: ${finding.severity}`, "- Location:", "```text",
    finding.file === "" ? "(repository)" : `${finding.file}${finding.line === undefined ? "" : `:${finding.line}`}`,
    "```", "- Rule:", "```text", finding.rule, "```", "- Message/evidence:", "```text", finding.message,
    "```", "- Suggested remediation (advice only):", "```text", "No remediation supplied", "```",
  ])].join("\n");
}

function summaryFor(finding: { severity: string; file: string; line: number; rule: string; message: string }): string {
  return summaryForMany([finding]);
}

function inlinePayload(finding: typeof deletionFinding, side: "LEFT" | "RIGHT") {
  return {
    commit_id: "a".repeat(40), body: "lupa: 1 finding(s).", event: "COMMENT" as const,
    comments: [{ path: finding.file, line: finding.line, side, body: `**${finding.severity}** [${finding.rule}] ${finding.message}` }],
  };
}

const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const PR_NUMBER = 17;
const SYNTHETIC_REPO = "synthetic-owner/synthetic-repo";
const SYNTHETIC_BRANCH = "synthetic-branch";

const authzReviewPayload = {
  commit_id: HEAD_SHA,
  body: "lupa: 1 finding(s).",
  event: "COMMENT" as const,
  comments: [{
    path: "src/auth.ts",
    line: 2,
    side: "RIGHT" as const,
    body: "**warning** [authorization-missing] " + authzFinding.message,
  }],
};

const workflowRunPayload = {
  workflow_run: {
    head_sha: HEAD_SHA,
    head_repository: { full_name: SYNTHETIC_REPO },
    head_branch: SYNTHETIC_BRANCH,
  },
};

function flowBMeta(prNumber: number): string {
  return JSON.stringify(
    { pr_number: prNumber, head_sha: HEAD_SHA, base_sha: BASE_SHA, head_repo_full_name: SYNTHETIC_REPO, is_fork: false },
    null,
    2,
  ) + "\n";
}

const flowBArtifactFindings = JSON.stringify([authzFinding], null, 2) + "\n";

const staleSkipNote =
  `lupa: PR head moved during posting; analyzed ${HEAD_SHA}, live ${"c".repeat(40)}; ` +
  "skipping review for the stale head — a fresh run will cover the new head.";

export const evalCases: readonly EvalCase[] = [
  {
    id: "synthetic-positive-authz-unguarded-record-read",
    categories: ["positive"],
    syntheticRationale: "Synthetic seeded regression: the changed return path has no ownership check.",
    patchFixture: "positive-authz.patch",
    llmFindings: [authzFinding],
    expected: {
      promptDiffSnippet: "+  return record;",
      findings: [authzFinding],
      exitCode: 2,
      summary: authzSummary,
      publication: {
        kind: "review",
        payload: {
          commit_id: "a".repeat(40),
          body: "lupa: 1 finding(s).",
          event: "COMMENT",
          comments: [{
            path: "src/auth.ts",
            line: 2,
            side: "RIGHT",
            body: "**warning** [authorization-missing] " + authzFinding.message,
          }],
        },
      },
    },
  },
  {
    id: "synthetic-positive-command-shell-interpolation",
    categories: ["positive"],
    syntheticRationale: "Synthetic seeded regression: untrusted archive input is interpolated into a shell command.",
    patchFixture: "positive-command.patch",
    llmFindings: [commandFinding],
    expected: {
      promptDiffSnippet: "+exec(\x60tar -xf ${archiveName}\x60);",
      findings: [commandFinding],
      exitCode: 2,
      summary: commandSummary,
      publication: {
        kind: "review",
        payload: {
          commit_id: "a".repeat(40),
          body: "lupa: 1 finding(s).",
          event: "COMMENT",
          comments: [{
            path: "src/archive.ts",
            line: 2,
            side: "RIGHT",
            body: "**warning** [shell-argument-interpolation] " + commandFinding.message,
          }],
        },
      },
    },
  },
  {
    id: "synthetic-safe-negative-greeting-format",
    categories: ["safe-negative"],
    syntheticRationale: "Synthetic safe control: formatting a greeting does not cross a security boundary.",
    patchFixture: "safe-negative.patch",
    llmFindings: [],
    expected: {
      promptDiffSnippet: "+  return \x60Hello, ${name}\x60;",
      findings: [],
      exitCode: 0,
      summary: "lupa: no findings.",
      publication: { kind: "review", payload: cleanPayload },
    },
  },
  {
    id: "synthetic-repaired-authz-owner-check",
    categories: ["repaired"],
    syntheticRationale: "Synthetic repaired control: the changed return is guarded by an ownership check.",
    patchFixture: "repaired-authz.patch",
    llmFindings: [],
    expected: {
      promptDiffSnippet: "+  if (!user.isOwner(record)) throw new Error(\"forbidden\");",
      findings: [],
      exitCode: 0,
      summary: "lupa: no findings.",
      publication: { kind: "review", payload: cleanPayload },
    },
  },
  {
    id: "synthetic-deletion-removed-unsafe-branch",
    categories: ["deletion"],
    syntheticRationale: "Synthetic deletion regression: a removed legacy branch is reported on its old-file line.",
    patchFixture: "deletion.patch",
    llmFindings: [deletionFinding],
    expected: {
      promptDiffSnippet: "-  return privileged();",
      findings: [deletionFinding], exitCode: 2, summary: summaryFor(deletionFinding),
      publication: { kind: "review", payload: inlinePayload(deletionFinding, "LEFT") },
    },
  },
  {
    id: "synthetic-force-push-head-moves-before-post",
    categories: ["force-push"], syntheticRationale: "Synthetic race regression: the PR head moves between analysis and review publication.",
    patchFixture: "force-push.patch", fakeGatewayMode: "headMovesBeforePost", llmFindings: [forceFinding],
    expected: {
      promptDiffSnippet: "+  state = next;", findings: [forceFinding], exitCode: 2, summary: summaryFor(forceFinding), publication: { kind: "none" },
    },
  },
  {
    id: "synthetic-fork-readonly-summary-only",
    categories: ["fork-readonly"], syntheticRationale: "Synthetic permission regression: a fork with a read-only token still emits its summary without writes.",
    patchFixture: "fork-readonly.patch", fakeGatewayMode: "isFork",
    envOverrides: { tokenType: "github-token", issueFallback: true }, llmFindings: [forkFinding],
    expected: {
      promptDiffSnippet: "+  enabled = true;", findings: [forkL2Skipped, forkFinding], exitCode: 2,
      summary: summaryForMany([forkL2Skipped, forkFinding]), publication: { kind: "none" },
    },
  },
  {
    id: "synthetic-large-diff-per-file-cap",
    categories: ["large-diff"], syntheticRationale: "Synthetic truncation regression: one changed file exceeds the per-file prompt excerpt cap.",
    patchFixture: "large-per-file.patch", inputOverrides: { maxDiffChars: 12000 },
    expected: {
      promptDiffSnippet: "--- src/large.ts", findings: [], exitCode: 0, summary: "lupa: no findings.", publication: { kind: "review", payload: cleanPayload },
    },
  },
  {
    id: "synthetic-large-diff-global-budget",
    categories: ["large-diff"], syntheticRationale: "Synthetic omission regression: the global prompt allowance includes one file and omits another.",
    patchFixture: "large-total.patch", inputOverrides: { maxDiffChars: 100 },
    expected: {
      promptDiffSnippet: "--- src/included.ts", findings: [], exitCode: 0, summary: "lupa: no findings.", publication: { kind: "review", payload: cleanPayload },
    },
  },
  {
    id: "synthetic-unchanged-baseline-not-in-diff",
    categories: ["unchanged-baseline"], syntheticRationale: "Synthetic baseline control: a vulnerable-looking unchanged file is present beside a safe changed file.",
    patchFixture: "unchanged-baseline.patch",
    repoFiles: { "src/legacy-vulnerability.ts": "export function legacy(input: string) { return eval(input); }\n" },
    expected: {
      promptDiffSnippet: "+  return `ready: ${name}`;", findings: [], exitCode: 0, summary: "lupa: no findings.", publication: { kind: "review", payload: cleanPayload },
    },
  },
  {
    id: "synthetic-flow-b-publish-artifact",
    categories: ["flow-b"],
    syntheticRationale: "Synthetic privileged flow: the workflow_run post replays the PR run's staged artifact without re-analysis.",
    patchFixture: "positive-authz.patch",
    eventOverride: { eventName: "workflow_run", payload: workflowRunPayload },
    artifactFiles: { "pr-meta.json": flowBMeta(PR_NUMBER), "findings.json": flowBArtifactFindings },
    fakeGatewayMode: "flowBPrs",
    llmFindings: [],
    expected: {
      promptDiffSnippet: "", findings: [authzFinding], exitCode: 2, summary: authzSummary,
      publication: { kind: "review", payload: authzReviewPayload },
    },
  },
  {
    id: "synthetic-dry-run-post-comment-off",
    categories: ["dry-run"],
    syntheticRationale: "Synthetic dry-run control: post_comment false writes the summary and publishes nothing.",
    patchFixture: "positive-authz.patch",
    inputOverrides: { postComment: false },
    llmFindings: [authzFinding],
    expected: {
      promptDiffSnippet: "+  return record;", findings: [authzFinding], exitCode: 2, summary: authzSummary,
      publication: { kind: "none" },
    },
  },
  {
    id: "synthetic-non-trigger-push-event",
    categories: ["non-trigger"],
    syntheticRationale: "Synthetic non-trigger control: a push event never starts analysis or writes to GitHub.",
    patchFixture: "positive-authz.patch",
    eventOverride: { eventName: "push", payload: {} },
    expected: {
      promptDiffSnippet: "",
      findings: [],
      exitCode: 0,
      summary: `lupa: event "push" does not trigger a review; nothing to do.`,
      publication: { kind: "none" },
    },
  },
  {
    id: "synthetic-issue-fallback-after-refusal",
    categories: ["issue-fallback"],
    syntheticRationale: "Synthetic refusal regression: a refused review post degrades to the issue-comment fallback report.",
    patchFixture: "positive-authz.patch",
    fakeGatewayMode: "refusedReview",
    envOverrides: { issueFallback: true },
    llmFindings: [authzFinding],
    expected: {
      promptDiffSnippet: "+  return record;", findings: [authzFinding], exitCode: 2, summary: authzSummary,
      publication: { kind: "issue-comment", body: authzSummary },
    },
  },
  {
    id: "synthetic-scanner-merge-into-review",
    categories: ["scanner-merge"],
    syntheticRationale: "Synthetic merge control: a scanner finding reaches the review and the SARIF artifact beside an empty LLM result.",
    patchFixture: "positive-authz.patch",
    scannerFindings: [authzFinding],
    l2Findings: [mergeL2Note],
    llmFindings: [],
    expected: {
      promptDiffSnippet: "+  return record;", findings: [authzFinding, mergeL2Note], exitCode: 2,
      summary: summaryForMany([authzFinding, mergeL2Note]),
      publication: {
        kind: "review",
        payload: {
          ...authzReviewPayload,
          body: "lupa: 2 finding(s).\n\n**Findings not placed inline:**\n- **info** (repository) [l2-note] Synthetic L2 note.",
        },
      },
    },
  },
  {
    id: "synthetic-high-gate-request-changes",
    categories: ["high-gate"],
    syntheticRationale: "Synthetic gate regression: fail_level high turns a high-severity finding into REQUEST_CHANGES.",
    patchFixture: "positive-authz.patch",
    inputOverrides: { failLevel: "high" },
    llmFindings: [highFinding],
    expected: {
      promptDiffSnippet: "+  return record;",
      findings: [highFinding],
      exitCode: 1,
      summary: summaryForMany([highFinding]),
      publication: {
        kind: "review",
        payload: {
          commit_id: HEAD_SHA,
          body: "lupa: 1 finding(s).",
          event: "REQUEST_CHANGES",
          comments: [{ path: "src/auth.ts", line: 2, side: "RIGHT", body: "**high** [missing-auth] " + highFinding.message }],
        },
      },
    },
  },
  {
    id: "synthetic-llm-failure-fast-only",
    categories: ["llm-failure"],
    syntheticRationale: "Synthetic provider refusal: a failed LLM call leaves the fast-only findings and a clean review.",
    patchFixture: "positive-authz.patch",
    llmError: { reason: "content-filter", detail: "synthetic refusal" },
    expected: {
      promptDiffSnippet: "+  return record;", findings: [], exitCode: 0,
      summary: "lupa: dedup skipped (slow path unavailable); scanner findings published unmerged\nlupa: no findings.",
      publication: { kind: "review", payload: cleanPayload },
    },
  },
  {
    id: "synthetic-stale-on-post-skip",
    categories: ["stale-post"],
    syntheticRationale: "Synthetic stale race: GitHub rejects the post as stale and the run exits cleanly without a review.",
    patchFixture: "positive-authz.patch",
    fakeGatewayMode: "staleOnPost",
    llmFindings: [authzFinding],
    expected: {
      promptDiffSnippet: "+  return record;",
      findings: [authzFinding],
      exitCode: 0,
      summary: `${authzSummary}\n${staleSkipNote}`,
      publication: { kind: "none" },
    },
  },
];

/** Flow B's artifact-binding refusal: run() rejects, so it never joins evalCases/it.each. */
export const flowBRefusalCase: EvalCase = {
  id: "synthetic-flow-b-refusal-pr-mismatch",
  categories: ["flow-b"],
  syntheticRationale: "Synthetic artifact-binding regression: the artifact's pr_number disagrees with the PR derived from workflow_run.",
  patchFixture: "positive-authz.patch",
  eventOverride: { eventName: "workflow_run", payload: workflowRunPayload },
  artifactFiles: { "pr-meta.json": flowBMeta(999), "findings.json": flowBArtifactFindings },
  fakeGatewayMode: "flowBPrs",
  llmFindings: [],
  // run() rejects for this case, so expected is never asserted: it keeps the fresh-outcome defaults.
  expected: {
    promptDiffSnippet: "", findings: [], exitCode: 0, summary: "",
    publication: { kind: "none" },
  },
};
