import type { EvalCase } from "../../evals/types.js";

export const EVAL_CORPUS_VERSION = 1;

const authzFinding = {
  severity: "warning",
  file: "src/auth.ts",
  line: 2,
  rule: "authorization-missing",
  message: "The new path returns a record without checking that the caller may read it.",
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
    envOverrides: { tokenIsApp: false, issueFallback: true }, llmFindings: [forkFinding],
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
];
