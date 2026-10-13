# Aggregate LLM usage logging — design spec

Date: 2026-10-13 | Status: draft (design approved) | Branch: `usage-sarif`
Source: `PROJECT_FINDINGS.md` Evolutions §4 ("log aggregate usage and coverage state without content/secrets")

## 1. Goal

Each run logs aggregate LLM token usage (numbers only, never content) to the
job log and the step summary, so BYOK spend is observable per PR review.

## 2. Approach (approved)

Optional `usage` rides the existing result types and is absent when the
provider omits it — zero churn on the ~100 exact-shape pins. Per-adapter
extraction normalizes to `{input, output}`; `slowPath` sums what it consumes
and emits one line. Residual: probe retries and failed attempts are uncounted
(only consumed results aggregate); providers without usage (some custom
endpoints) report unknown.

## 3. Interfaces

```ts
// llm.ts
export interface LlmUsage { input: number; output: number }
type LlmResult = ... | { ok: true; findings: Finding[]; verdicts?: DedupVerdicts; usage?: LlmUsage } | ...;
type AgentReply = ... | { ok: true; text: string | undefined; toolCalls: ToolCall[]; rawItems?: unknown[]; usage?: LlmUsage } | ...;
// agent.ts
interface AgentOutcome { ..., usage?: LlmUsage } // summed over turns, absent when nothing observed
```

## 4. Exact behavior

- **Extraction (per completed call, success or failure-with-usage):**
  chat → `{input: usage.prompt_tokens, output: usage.completion_tokens}`;
  responses → `{input: usage.input_tokens, output: usage.output_tokens}`;
  messages → `{input: usage.input_tokens, output: usage.output_tokens}`;
  google → `{input: usageMetadata.promptTokenCount, output: (totalTokenCount − promptTokenCount) when both present else candidatesTokenCount}`
  (cached/thoughts fold into input/output respectively — no third field).
  Non-finite or negative values → field absent (never NaN/negative in output).
- **Carriage:** adapters attach `usage` only when extracted (absent otherwise —
  all existing fixtures stay green unchanged); `toFindings`/`stripProvenance`
  ignore it (not a finding field, not provenance); `isFinding`/sanitize/redact
  never see it (never serialized to artifacts — log/summary only, no secret
  surface by construction).
- **Aggregation:** single-shot sums the winning result's usage; agent sums
  per-turn `AgentReply.usage` into `AgentOutcome.usage` (turns without usage
  contribute zero). `slowPath` emits one `note()` line (log + summary):
  `lupa: llm usage input=<n> output=<m> tokens (calls=<k>)`, or
  `lupa: llm usage unknown (provider omitted usage)` when nothing observed.
  Numbers only — no model text, no prompts, no findings.
- **Untouched.** Gates, findings, bodies, SARIF/artifact, F15, `Outcome`
  shape, `Analysis` interface (usage rides inside existing return types —
  fakes need no changes), prompt text, budgets.

## 5. Tests

- Per-adapter extraction units (usage present → exact `{input, output}`;
  usage absent/malformed → field absent; all four protocols).
- `AgentReply`/`AgentOutcome` sum units (mixed present/absent turns).
- `slowPath` note-line pin (exact string; unknown-variant pin).
- Full suite + evals green with NO pin updates (absent-when-missing proves
  itself — any red pin is a defect in the change, not the test).
- `failLevel` semantics unchanged.

## 6. Implementation split (plan preview)

Single task (one reviewer gate): helpers + carriage + aggregation + note
(`extractUsage` per adapter, result-type fields, agent sum, `slowPath` note,
units + note pin). No parallel work; pairs with the SARIF task in one plan.

## 7. Constraints and residuals

No new runtime dependencies, no new action inputs, stable namespace,
no template/CI changes, `dist/` committed, suite + evals green. Ships with
the next release vehicle — no tag alone. Accepted residuals: probe-retry and
failed-attempt spend uncounted; unknown providers report unknown; per-model
pricing left to the README cost section (no cost math in code).
