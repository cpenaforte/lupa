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
export interface LlmUsage { input: number; output: number; calls: number } // calls = contributing results (adapters attach 1; sums add)
type LlmResult = ... | { ok: true; findings: Finding[]; verdicts?: DedupVerdicts; usage?: LlmUsage } | ...;
type AgentReply = ... | { ok: true; text: string | undefined; toolCalls: ToolCall[]; rawItems?: unknown[]; usage?: LlmUsage } | ...;
// agent.ts
interface AgentOutcome { ..., usage?: LlmUsage } // summed over turns, absent when nothing observed
```

## 4. Exact behavior

- **Extraction (one shared helper):** `extractUsage(body: unknown, apiStyle)` in `llm.ts`, called by all 8 call sites (`callLlm`/`callChatTurn`, `callResponses`/`callResponsesTurn`, `callMessages`/`callMessagesTurn`, `callGoogle`/`callGoogleTurn`) on the parsed JSON; adapters import it (as they import schema types today). extractUsage returns `{input, output}` only (pure shape normalization — counting is not its job); each of the 8 call sites attaches `calls: 1` alongside it. Usage present iff input AND output are both finite numbers ≥ 0 — partial objects yield absent, never half-shaped. Non-object bodies (null, arrays, primitives) yield absent (adapters never reject on shape — agent.ts relies on it). Mappings:
  chat → `{input: usage.prompt_tokens, output: usage.completion_tokens}`;
  responses → `{input: usage.input_tokens, output: usage.output_tokens}`;
  messages → `{input: usage.input_tokens + (cache_read_input_tokens ?? 0) + (cache_creation_input_tokens ?? 0), output: usage.output_tokens}` (cache tokens are billed input — folding them is required; a missing `input_tokens` itself means absent, caches alone do not form an input);
  google → `{input: usageMetadata.promptTokenCount, output: (totalTokenCount − promptTokenCount) when both present else candidatesTokenCount}`
  (cached/thoughts fold into input/output respectively — no third field).
  Non-finite or negative values → field absent (never NaN/negative in output — covers negative derived values too). `promptTokenCount` already includes cached tokens: no addition.
- **Carriage.** Adapters attach `extractUsage()` output to ok:true results only
  (absent when unextractable — all existing fixtures stay green unchanged;
  ok:false NEVER carries usage (deliberate shape policy, not unobservability: invalid-json bodies, length-cutoff failures, and earlier-turn spend dropped by a later failure are real spend we choose not to carry — listed residuals): failed-run spend is unobservable at this layer
  and stays a listed residual). `AgentReply` ok:true gains optional `usage`;
  `runAgent` accumulates per-turn `AgentReply.usage` inside `callWithDeadline`
  (the sole `hooks.call` funnel — accumulate on the non-raced branch only, so a late dangling resolution cannot add after `finish`; ok replies with usage only) into locals next
  to `turns`/`calls`/`bytes`, and `finish()` attaches the total as
  `AgentOutcome.usage` (absent when zero contributions — every exit flows
  through `finish`, so no return site is missed; raced-timeout spend is lost
  with the discarded reply, listed residual). `callByStyleAgent` /
  `callWithProbeAgent` copy `outcome.usage` onto an ok:true `result.usage`
  (overwrite, conditional on `outcome.usage !== undefined` so no explicit `usage: undefined` key is written — the agent total supersedes any single-turn value), so
  `Analysis` (`Promise<LlmResult>`) and all fakes stay byte-identical.
  `toFindings`/`stripProvenance` ignore it (not a finding field, not
  provenance); `isFinding`/sanitize/redact never see it (never serialized to
  artifacts — log/summary only, no secret surface by construction).
- **Aggregation:** `slowPath` reads `result.usage` off the consumed result (single-shot winner or agent total — both arrive on ok:true `LlmResult.usage` via §4 carriage) and emits one `note()` line (log + step-summary file only — never into review bodies or issue comments, so main.test.ts:761-style pins are unaffected), placed after verdict post-processing on each success return (next to the existing slow-path outcome logs):
  `lupa: llm usage input=<n> output=<m> tokens (calls=<k>)`, or
  nothing observed → NO line at all (skip paths, failed runs, and
  usage-less providers stay silent — this keeps eval summaries and
  skip-path output byte-identical, so no pin updates). `calls=<k>` counts
  contributing results only (k≥1 whenever emitted — single-shot exactly 1, agent the contributing-turn count; distinct from the agent-done tool-call `calls=` on its own line).
  Numbers only — no model text, no prompts, no findings.
- **Untouched.** Gates, findings, bodies, SARIF/artifact, F15, `Outcome`
  shape, `Analysis` interface (usage rides inside existing return types —
  fakes need no changes), prompt text, budgets.

## 5. Tests

- Per-adapter extraction units (extractUsage present → exact `{input, output}` (no calls key at this layer; attach-point adds `calls: 1`);
  usage absent/malformed → field absent; all four protocols).
- `AgentReply`/`AgentOutcome` sum units (mixed present/absent turns).
- `slowPath` note-line pin (exact string) + silence pin (no-usage run emits no line — asserts the eval-safe behavior).
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
failed-attempt spend uncounted; usage-less providers/skips/failures emit no line (silence is the design, not a gap); per-model
pricing left to the README cost section (no cost math in code).
