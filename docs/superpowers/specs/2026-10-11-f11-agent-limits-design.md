# Sub-project F11: whole-agent limits — design

Date: 2026-10-12
Status: design approved (2026-10-12)
Source: Codex audit `PROJECT_FINDINGS.md` (F11), local HEAD `e053c07`
Goal: carry one absolute deadline and one cumulative result-byte allowance through
probing, retry, tools, traversal, and linked clones — with markers inside caps and
valid tool-result envelopes.

## Decisions (approved)

- Scope: F11 only (`src/agent.ts`, `src/llm.ts` agent probe paths, `src/agent-tools.ts`
  tool entry, `src/linked-repos.ts` clone timeouts, `src/main.ts` linked closure).
  No adapter-protocol changes (adapters never see the deadline; retry/sleep behavior
  inside adapters is unchanged by construction) and no template or CI changes.
  The 429/5xx retry overshoot is bounded by racing `hooks.call`, not by touching
  adapters (ruled — see §2).
- Deadline plumbing: explicit `deadlineMs` epoch-ms parameter (no shared mutable
  state); every layer clamps its own timeout to the remaining budget, and every
  `hooks.call` is raced against the absolute deadline (no residual past one settled
  timer cleanup).
- One absolute deadline per probe invocation (not per style); per-call byte checks
  bound round overshoot to one capped result; backstop replaces over-cap/corrupt
  tool output with an explicit error envelope.
- Turn logs and `elapsedMs` stay outside the caps (observability, not model input).
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

### One absolute deadline per probe invocation

```ts
// AgentHooks.callOpts gains one REQUIRED field:
callOpts: { timeoutSeconds: number; deadlineMs: number }
// AgentBudget gains one optional field:
deadlineMs?: number  // absolute epoch-ms; when present runAgent uses it verbatim
```

- `runAgent` uses `budget.deadlineMs ?? start + maxSeconds * 1000`, reusing the
  existing `start`/`deadline` locals — no new `clock()` reads (the `:166`
  `++reads` fixture is safe). All four `hooks.call` sites pass the absolute value.
- `timeoutFor` becomes `Math.max(1, Math.min(budget.timeoutSeconds, Math.floor(remaining / 1000)))` (floor keeps the
  absolute bound; the cap preserves the configured per-turn ceiling — dropping it would send
  `timeoutSeconds: 120` on a 60 s default; the existing 10 s `timedOut()` margin means the max-guard is
  unreachable in practice).
- `callWithProbeAgent` computes `Date.now() + maxSeconds * 1000` ONCE and threads
  `deadlineMs` into every `runStyle` budget (explicit and probe paths alike), so
  probed styles share one deadline instead of restarting it. `callByStyleAgent` /
  single-style paths are unchanged (one `runAgent` already means one deadline).
- `agentCallFor` is unchanged (it picks `timeoutSeconds` only — adapters never see
  the deadline, so no adapter `o` type changes and no `tsc` breakage there).
- Every `hooks.call` in `runAgent` is raced against the absolute deadline (see
  "In-flight race" below) — this bounds adapter sleeps/retries without touching
  adapters, replacing the old per-turn-timeout-only residual.
- Existing `seenOpts` `toEqual({ timeoutSeconds })` assertions gain the `deadlineMs`
  field (intentional updates, named per task).

### In-flight race (bounds adapter sleeps/retries without touching adapters)

A per-turn `timeoutSeconds` clamp cannot bound a 429/5xx retry (full-timeout
attempt + ≤5 s sleep + full-timeout retry ≈ 2× remaining + 5 s worst case), so
every `hooks.call` in `runAgent` goes through one helper:

```ts
callWithDeadline(flags, opts, nowMs): Promise<{ reply: AgentReply; raced: boolean }>
```

- `ms = deadline - nowMs` (`nowMs` passed in from the already-read clock values at
  each of the four call sites — no new `clock()` reads, so the `:166` `++reads`
  fixture is safe).
- `ms <= 0` → return `{ reply: timeoutResult, raced: true }` WITHOUT invoking
  `hooks.call` (deterministic under fake clocks).
- Else `Promise.race` between `hooks.call(...)` and a real-timer fallback resolving
  the same timeout result. The timer is cleared on settle; the dangling inner promise
  gets a noop-catch at race time (adapters resolve `LlmResult` by contract and never
  reject — the branch is timer hygiene only).
- `timeoutResult` is `{ ok: false, result: { ok: false, reason: "timeout", detail: <existing TIMEOUT_DETAIL> } }`
  (reuse the constant, not a copy).
- `raced === true` → `finish(timeoutResult, "budget", false)` at every site (same
  stop as loop-level expiry — no string matching, no new reason codes). `raced`
  false flows through the existing per-site handling untouched.

Deterministic tests (no live timing): pre-expired deadline asserts `hooks.call`
uncalled + `stop: "budget"`; fake-timer test advances past the deadline mid-call and
asserts the race wins with `stop: "budget"`; far-future deadline + immediate hook
asserts `raced: false` and normal handling.

### Tool/clone enforcement

```ts
// executeTool gains one optional parameter:
executeTool(name, args, ctx, limits?: { deadlineMs?: number; maxResultBytes?: number })
```

- runAgent's tool loop supplies both on every call: `deadlineMs` is the run's
  absolute deadline converted to wall-clock (`Date.now() + max(0, deadline - clock())`
  — the loop clock may be fake in tests while tool timers are real; the conversion
  keeps them consistent, identity in production); `maxResultBytes` is the per-call
  effective cap from the byte rules below. No other caller passes `limits` (existing
  3-arg callers compile).
- `deadlineMs` here is an absolute epoch (durations stay `timeoutMs`/`maxMs`
  everywhere — units stated at each conversion). `WalkLimits.deadlineMs` (F13) stays
  a *duration*; the conversion to absolute happens at the `executeTool` entry, so the
  two same-named fields never mix. Existing 3-arg callers compile.
- grep path: entry-expired (`end - Date.now() <= 0`) returns the existing
  `"grep timed out"` error without walking or spawning. Otherwise the walk gets
  duration `min(limits?.deadlineMs ?? WALK_DEFAULT_DEADLINE_MS, max(0, end-now))`
  (never relaxes an explicit F13 bound or the default), and after
  the walk the worker timeout is recomputed as `min(timeoutMs, max(0, end-now))`
  where `timeoutMs` is `grepInRoot`'s own parameter (default `GREP_TIMEOUT_MS`) —
  never the constant alone, so an explicit caller bound (e.g. 200 ms in tests) is
  preserved. Expired → timeout error, no spawn. `grepInRoot(root, args, timeoutMs?,
  limits?, endMs?)` and `grep()` forward the absolute end.
  Each tool function takes the per-call cap explicitly: `readFile`/`grep` parameterize
  their caps; `listDir(args, ctx, maxBytes?)` / `glob(args, ctx, maxBytes?)` take an
  optional trailing cap for entry-dropping; `errorResult` caps via the constant.
- `walkPaths` via glob: duration `min(WALK_DEFAULT_DEADLINE_MS, max(0, end-now))`;
  entry-expired → `errorResult("glob timed out")` (exact text, mirroring grep — glob
  has no timeout today). `read_file`/`list_dir` are synchronous bounded work — no deadline
  (stated).
- `resolveRoot`/`rootFor` thread the value into `ToolContext.ensureLinked(alias,
  opts?: { deadlineMs?: number })`; the `main.ts` linked closure forwards
  `opts?.deadlineMs` into `ensureLinkedRepo` (its only change).
- `ensureLinkedRepo(alias, { …, deadlineMs?: number })` (absolute epoch, wall-clock
  `Date.now` like the grep/walk paths — mixed-clock note: agent-loop tests use fake
  clocks, clone tests use real short timeouts): central
  `effectiveTimeout(configuredMs, endMs?, nowMs = Date.now())` helper (the `nowMs`
  default keeps production call sites clean; tests pass it explicitly for
  determinism) — no deadline → configured; `end - now <= 0`
  → expired without spawning (existing `repository not accessible: <alias>: …`
  error shape with detail `deadline exceeded`); else `max(1, min(configured, remaining))`
  (floor 1: a bare 0 would mean no-timeout in `execFile`). Applied to clone,
  `cloneHead`, and validation git calls: ANY `"expired"` at any site aborts with the
  error immediately — no spawn, and never `removeDir` on an existing dir (the
  validator returns `"expired"` distinctly from `null`, and the caller maps it to
  the error with no wipe; a mid-validation expiry aborts the same way rather than
  recloning). The `sizeKb` lookup is explicitly out of scope (GitHub API, not git).

### Byte allowance (exact)

`bytes` counts content outputs only: every tool result shown to the model —
including tool *error* outputs (`errorResult`, confinement/size refusals) — with
markers included. Bookkeeping records generated by the loop itself
(budget-exhausted errors, backstop replacements, too-many-calls errors),
turn logs, and `elapsedMs` are excluded (observability/metadata, each a fixed
envelope ≤ 65 B by construction: 65/56/51 B measured).

- Tools cap payloads to `limits?.maxResultBytes ?? AGENT_LIMITS.resultBytes`:
  `read_file`/`grep` parameterize their existing marker-inside caps (same behavior
  at default); `list_dir`/`glob` drop tail entries (`truncated` stays true — the
  flag IS the signal, no marker needed); `errorResult` caps messages at 2000 chars
  with the marker inside (`ERROR_MESSAGE_CAP = 2000`, new constant).
- runAgent per tool call: `remaining = maxTotalBytes - bytes`; `remaining < markerBytes`
  (12, the `\n[truncated]` marker — below which no content output can fit) →
  skip execution, record `{"error":"tool result budget exhausted (max <maxTotalBytes> bytes)"}`
  (exact text with the number), do NOT increment `calls`; else pass
  `maxResultBytes: min(maxResultBytes, remaining)` so content totals stay exactly bounded.
  (A bare `remaining <= 0` is subsumed: it is always `< markerBytes`.)
- Backstop replaces `capOutput` (removed): exported
  `capToolResult(output: string, maxBytes: number): string` — JSON parses AND
  `byteLength <= maxBytes` → passthrough unchanged; else →
  `{"error":"tool result exceeded the byte budget","truncated":true}` (exact).
  Never corrupts, never exceeds. runAgent invokes it on EVERY tool output (content
  and tool-error alike) with the per-call *effective* cap (`min(maxResultBytes,
  remaining)` — not the nominal: a remainder below a tool's minimum JSON envelope
  (~91 B for read_file) cannot fit any real output, so the backstop replaces it
  with the fixed 65 B envelope; the replacement is bookkeeping, excluded from
  `bytes`, which is what keeps content totals exactly bounded). Tool-layer caps
  below a tool's minimum envelope are therefore best-effort (envelope-only output);
  tests use caps ≥ 500. The old surrogate-safe test is superseded by
  backstop multibyte unit tests (named per task).
- Forced round-start gate: `turns >= maxTurns || bytes >= maxTotalBytes ||
  (maxTotalBytes - bytes) < markerBytes` (the residue clause: a remainder of 1–11 B
  can never fit even a marker, so the next round forces instead of looping to
  `maxTurns`). `bytes`/`turnBytes`
  accounting uses final output lengths.

## 3. Tests

`tests/agent.test.ts` (mocked clocks via `hooks.clock`, scripted hooks — no live timing),
`tests/agent-tools.test.ts`, `tests/linked-repos.test.ts` (deps.run fakes, real short
timeouts — no fake clocks there):

- runAgent with a pre-expired `AgentBudget.deadlineMs` stops before the first turn
  (no `hooks.call`); scripted hook advancing the fake clock past the deadline
  mid-conversation stops the loop after the current turn (no further calls).
- Race: pre-expired deadline asserts `hooks.call` UNCALLED + `stop: "budget"`;
  fake-timer advance past the deadline mid-call asserts the race wins with
  `stop: "budget"` (deterministic — no live timing); far-future deadline asserts
  normal handling (`raced: false` path).
- Fake clock at 10,500 ms remaining pins `timeoutSeconds === 10` in `seenOpts`
  (floor rule).
- Multi-round accumulation with per-call remaining caps: totals stay exactly bounded;
  exhausted calls record the exact budget-exhausted error without incrementing `calls`;
  the following round takes the forced path.
- `capToolResult` unit tests (exported): passthrough / over-cap replace /
  invalid-JSON replace / multibyte-safe (replaces the old `capOutput` surrogate test,
  named as superseded).
- `executeTool` with expired `deadlineMs`: grep and glob return timeout/error
  results without walking or spawning; `deadlineMs: <huge>` behaves exactly as today.
- grep worker recompute: walk consumes time (injectable via F13 `limits` + a
  near-zero post-walk budget is untestable deterministically — instead pin that a
  generous `endMs` preserves today's worker timeout and an expired `endMs` never
  spawns the worker thread (assert via `files_scanned`/error shape, not timing).
- Clone with an expired deadline returns the existing "not accessible" error shape
  (detail `deadline exceeded`) without spawning git (assert `deps.run` uncalled)
  and without wiping an existing dir; `effectiveTimeout` unit table passes `nowMs`
  explicitly (no deadline → configured; future → min; past/at → `"expired"`;
  `endMs = now + 1` → `1`, pinning the floor).
- Existing tests keep passing modulo named intentional updates: `seenOpts`
  `toEqual` gains `deadlineMs`; the `capOutput` surrogate test is replaced per above;
  turn accounting, forced-final note, repair flow, 400/404 probe paths unchanged.

## 4. Verification and release

- Gates: focused `tests/agent.test.ts`, full `vitest`, `tsc --noEmit`,
  `npm run build && node --check dist/index.js`, committed `dist/`.
- No canary (deadline behavior is mock-pinned; live timing is nondeterministic);
  no tag — ships with the whole-plan release.

## Out of scope

F10 (single-shot prompt budget — already shipped), F15 (aggregate output/payload
totals — the agent-internal tool-result allowance here is input-side only, not the
same contract), Q01–Q04, F14,
template/CI changes, new inputs or dependencies, changing retry counts or 429/5xx
rules, changing the `BUDGET_NOTE`/repair text, touching single-shot paths,
bounding the `sizeKb` lookup or `list_dir`'s synchronous read.
