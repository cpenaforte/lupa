# Sub-project F11: whole-agent limits — design

Date: 2026-10-12
Status: design approved (2026-10-12)
Source: Codex audit `PROJECT_FINDINGS.md` (F11), local HEAD `e053c07`
Goal: carry one absolute deadline and one cumulative result-byte allowance through
probing, retry, tools, traversal, and linked clones — with markers inside caps and
valid tool-result envelopes.

## Decisions (approved)

- Scope: F11 only (`src/agent.ts`, `src/llm.ts` agent paths, `src/agent-tools.ts`
  tool entry, `src/linked-repos.ts` clone timeouts). No adapter-protocol, template,
  or CI changes.
- Deadline plumbing: explicit `deadlineMs` epoch-ms parameter (no shared mutable
  state); every layer clamps its own timeout to the remaining budget.
- Truncation markers move inside their caps; tool-result envelopes truncate the
  payload string only, never the serialized JSON. Turn logs and `elapsedMs` stay
  outside the caps (observability, not model input).
- A started round completes (per-round check stays at round start — explicit policy,
  documented); the cumulative allowance decrements per result so the next round sees
  the true remainder.
- No new inputs: `llmAgentMaxSeconds`, `timeoutSeconds`, and the byte limits are the
  sources; no behavior change when budget remains.
- Ship with the whole-plan release — no tag for F11 alone (standing instruction:
  release after the conclusion of the whole roadmap plan).

## 1. Problem

Each probed protocol starts a fresh deadline: adapter retries get fresh request
timeouts, awaited tools/clones lack a shared cancellation deadline, and a final
successful request may return after the time budget. The total result budget is
checked at the next round, permitting a full round to overshoot; the truncation
marker is appended outside the per-result byte cap and can make JSON invalid.
Mocked executions demonstrated a 40-second completion under a 30-second budget,
four 30-second attempts under a 35-second setting, 251,464 result bytes under the
default 131,072-byte ceiling, and a capped 32,780-byte result of invalid JSON.

## 2. Design

### Deadline threading

```ts
// AgentHooks.callOpts gains one field:
callOpts: { timeoutSeconds: number; deadlineMs: number }
```

- `runAgent` computes the absolute `deadlineMs = start + maxSeconds * 1000` once
  (the existing `deadline`) and passes it down every `hooks.call`, alongside the
  already-clamped `timeoutSeconds`.
- `executeTool(name, args, ctx, limits?: { deadlineMs?: number })` — optional 4th
  param (existing callers compile). The grep worker timeout becomes
  `min(GREP_TIMEOUT_MS, remaining)`; the F13 walk `limits.deadlineMs` is set from
  the same remaining value (F13's own defaults stand when no deadline is passed).
- `ensureLinkedRepo(alias, { …, deadlineMs?: number })` — every git timeout becomes
  `min(configured, remaining)`; expiry keeps the existing "not accessible"
  tool-error contract (bounded wait, same shape).
- Adapter `attempt`/retry in the agent path (`agentCallFor`): per-attempt timeout
  clamps to remaining; retry *count* and 429/5xx rules unchanged. A retry with no
  remaining time makes no further attempt (returns the last result).
- `AgentBudget` unchanged — the deadline derives from `start + maxSeconds`.

### Byte allowance

- `capOutput`: cut the payload to `maxResultBytes − markerBytes` (marker =
  `"\n[truncated]"`), then append — total never exceeds the cap, byte-exact.
- Tool-result envelopes (`{"output": …}`, error JSON) truncate the payload string
  only; the serialized envelope structure is never cut, so capped results always
  parse.
- The `BUDGET_NOTE`-forced turn's note counts against the round's bytes.
- The per-round `bytes >= maxTotalBytes` gate stays at round start (a started round
  completes — stated policy); the cumulative counter decrements per capped result,
  so the following round enforces the true remainder.

## 3. Tests

`tests/agent.test.ts` (mocked clocks via `hooks.clock`, scripted hooks — no live timing):

- A delayed tool whose own timeout exceeds the remaining budget aborts at the
  deadline (assert the outcome reason/elapsed, not the tool's timeout).
- Retry with no remaining time makes no further attempt (call count pinned).
- Multi-round byte accumulation: results summing past `maxTotalBytes` stop the next
  round (`forced` path) with the remainder accounted.
- Capped envelopes parse as JSON; total bytes ≤ cap with the marker inside.
- Clone with an expired deadline returns the existing "not accessible" error
  without waiting the full clone timeout (fake timer/expired `deadlineMs`).
- Existing tests keep passing (turn accounting, forced-final note, repair flow,
  400/404 probe paths, surrogate-safe truncation).

## 4. Verification and release

- Gates: focused `tests/agent.test.ts`, full `vitest`, `tsc --noEmit`,
  `npm run build && node --check dist/index.js`, committed `dist/`.
- No canary (deadline behavior is mock-pinned; live timing is nondeterministic);
  no tag — ships with the whole-plan release.

## Out of scope

F10 (single-shot prompt budget — already shipped), F15 (aggregate output limits —
only the agent-internal byte allowance is tracked here), Q01–Q04, F14,
template/CI changes, new inputs or dependencies, changing retry counts or 429/5xx
rules, changing the `BUDGET_NOTE`/repair text, touching single-shot paths.
