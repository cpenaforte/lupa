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
];
