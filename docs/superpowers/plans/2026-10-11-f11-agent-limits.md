# F11 whole-agent limits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce one absolute deadline and one exact cumulative result-byte allowance across agent turns, tools, traversal, and linked clones.

**Architecture:** Task 59 wires deadlines and byte caps through the tool layer; Task 60 enforces them in the agent loop and probe (race, floor, exact accounting, backstop); Task 61 makes linked clones deadline-aware and forwards the closure. Ordered by dependency (59 → 60 → 61); sequential dispatch, rebuild per task. (Roadmap Task 48 is the F11 *stage*; implementation Tasks 59–61 below are its execution units.)

**Tech Stack:** TypeScript 5.x, Node >=24, vitest, esbuild (`dist/` committed).

**Spec:** `docs/superpowers/specs/2026-10-11-f11-agent-limits-design.md`

## Global Constraints

- No new runtime dependencies (node builtins + existing deps only). No new action inputs. `PR_REVIEWER_*` env names, `pr-reviewer-*` concurrency/artifact strings, `pr-reviewer/1.0` user-agent, SARIF driver name, and `lupa:` log prefixes stay unchanged.
- Every task ends with `npx tsc --noEmit -p tsconfig.json`, `npm run build && node --check dist/index.js` and commits `dist/index.js`.
- Full suite (`npx vitest run`) + evals (`npm run evals`) green before every task commit; no test deleted without a replacement asserting the new contract (the `capOutput` surrogate test is replaced by backstop tests — named in Task 60).
- Commit messages use the exact strings given per task.
- Ships with the whole-plan release — no tag for F11 alone.

## Review Focus

- **An expired deadline at any layer must fail fast with zero work started** (no `hooks.call`, no walk, no worker spawn, no git spawn). Tests in Task 60's step style (loop/tools) and Task 61's (clone).
- **Existing fake-clock loop tests keep passing; only the three named updates change
  (`seenOpts` type + `toEqual` incl. the `:170` floor case, the surrogate-test
  replacement, the `"forced final on bytes budget"` `:138` re-expectation).**
  Test in Task 60's step style (full suite green + the three named updates).
- **Mid-conversation expiry stops the loop after the current turn**, never mid-turn and never advancing the probe. Test in Task 60's step style (advancing fake clock + `probeAdvance: false`).
- **A sub-marker remainder skips; a sub-envelope remainder backstop-replaces (excluded
  from `bytes`, fixed 65 B envelope).** Tests in Task 60's step style (skip case:
  exact exhausted error, `calls` unmoved; backstop case: exact backstop envelope,
  `bytes ≤ total`).
- **An expired clone validation never wipes a valid cache dir.** Test in Task 61's step style (plain dir + expired deadline → error + dir intact).

---

### Task 59: F11 — tool-layer deadlines and byte caps

**Files:**
- Modify: `src/agent-tools.ts` (`executeTool` limits, grep `endMs`/recompute, walk conversions, per-tool caps, `errorResult` cap, `TRUNCATION_MARKER` export, `resolveRoot`/`rootFor`/`ensureLinked` threading)
- Test: `tests/agent-tools.test.ts`
- Rebuild: `dist/index.js`

**Interfaces:**
- Consumes: F13 `WalkLimits`/`walkFiles`/`walkPaths`/`grepInRoot` (`WalkLimits.deadlineMs` stays a *duration*; absolute→duration conversion lives here, at the `executeTool` entry).
- Produces: `executeTool(name, args, ctx, limits?: { deadlineMs?: number; maxResultBytes?: number })` (`deadlineMs` absolute epoch, `maxResultBytes` per-call cap); exported `TRUNCATION_MARKER` (the existing `"\n[truncated]"` literal, 12 bytes); `ToolContext.ensureLinked` gains `opts?: { deadlineMs?: number }` (interface change at `src/agent-tools.ts:14`); `grepInRoot(root, args, timeoutMs?, limits?, endMs?)`; per-tool `maxBytes` trailing params; `ERROR_MESSAGE_CAP = 2000` (new constant).

**Exact behavior:**
- `deadlineMs` conversions: walk duration `min(limits?.deadlineMs ?? WALK_DEFAULT_DEADLINE_MS, max(0, end-now))` (never relaxes an explicit F13 bound or the default); grep worker recomputed post-walk as `min(timeoutMs, max(0, end-now))` where `timeoutMs` is the caller's (default `GREP_TIMEOUT_MS`) — an explicit 200 ms bound stays 200 ms. Entry-expired (`end-now <= 0`) returns the existing timeout/error result before any walk/spawn: grep → existing `"grep timed out"`, glob → new `errorResult("glob timed out")` (exact text). `read_file`/`list_dir` ignore deadlines (sync bounded work).
- Per-tool caps via trailing `maxBytes` (default `AGENT_LIMITS.resultBytes` 32768): `read_file`/`grep` parameterize existing marker-inside logic; `list_dir`/`glob` drop tail entries (`truncated` stays true); `errorResult` caps at `ERROR_MESSAGE_CAP = 2000` with marker inside. Caps below a tool's minimum JSON envelope (~91 B read_file) are best-effort (envelope-only output) — the loop-layer backstop (Task 60) is what bounds those; tests use caps ≥ 500.
- `resolveRoot(repo, ctx, deadlineMs?)` / `rootFor(args, ctx, deadlineMs?)` forward into `ensureLinked(alias, { deadlineMs })`; `read_file`'s 1 MiB refusal and confinement checks run before any deadline logic (unchanged order).

- [ ] **Step 1: Write the failing tests in `tests/agent-tools.test.ts`** (existing
  helpers `tempRoot` + `ctxFor` are reused; every root below is built inline)

```ts
it("expired deadlineMs fails fast without walking or spawning", async () => {
  const root = tempRoot();
  writeFileSync(join(root, "a.txt"), "hello\n");
  const ctx = ctxFor(root);
  const g = await executeTool("grep", { pattern: "x" }, ctx, { deadlineMs: 1 });
  expect(g.isError).toBe(true);
  expect(JSON.parse(g.output)).toEqual({ error: "grep timed out" });
  const gl = await executeTool("glob", { pattern: "**/*" }, ctx, { deadlineMs: 1 });
  expect(gl.isError).toBe(true);
  expect(JSON.parse(gl.output)).toEqual({ error: "glob timed out" });
});
it("huge deadlineMs behaves exactly as today", async () => {
  const root = tempRoot();
  writeFileSync(join(root, "a.txt"), "keep me\n");
  const g = await executeTool("grep", { pattern: "keep" }, ctxFor(root), { deadlineMs: Date.now() + 3600000 });
  expect(JSON.parse(g.output).matches.length).toBeGreaterThan(0);
});
it("per-tool maxResultBytes caps output with the marker inside", async () => {
  const root = tempRoot();
  writeFileSync(join(root, "big.txt"), "x\n".repeat(5000));
  const r = await executeTool("read_file", { path: "big.txt" }, ctxFor(root), { maxResultBytes: 500 });
  const p = JSON.parse(r.output);
  expect(Buffer.byteLength(r.output, "utf8")).toBeLessThanOrEqual(500);
  expect(p.truncated).toBe(true);
  expect(p.content).toContain("[truncated]");
});
it("errorResult messages are capped with the marker inside", async () => {
  const root = tempRoot();
  const r = await executeTool("read_file", { path: "a".repeat(5000) }, ctxFor(root));
  expect(r.isError).toBe(true);
  expect(Buffer.byteLength(r.output, "utf8")).toBeLessThanOrEqual(2000 + 100);
  expect(r.output).toContain("[truncated]");
});
it("list_dir and glob drop tail entries under a small cap", async () => {
  const root = tempRoot();
  for (let i = 0; i < 10; i++) writeFileSync(join(root, `f${i}.txt`), "x\n");
  const l = await executeTool("list_dir", { path: "." }, ctxFor(root), { maxResultBytes: 300 });
  const lp = JSON.parse(l.output);
  expect(lp.truncated).toBe(true);
  expect(lp.entries.length).toBeLessThan(10);
  expect(Buffer.byteLength(l.output, "utf8")).toBeLessThanOrEqual(300);
});
it("resolveRoot forwards the deadline to ensureLinked", async () => {
  const root = tempRoot();
  writeFileSync(join(root, "a.txt"), "hello\n");
  const seen: unknown[] = [];
  const ctx = { roots: { self: root }, ensureLinked: async (alias: string, opts?: { deadlineMs?: number }) => { seen.push(opts?.deadlineMs); return { error: "nope" }; } };
  await executeTool("read_file", { path: "a.txt", repo: "o/r" }, ctx, { deadlineMs: 123456789 });
  expect(seen).toEqual([123456789]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/agent-tools.test.ts`
Expected: FAIL (no `limits` param; no forwarding).

- [ ] **Step 3: Implement in `src/agent-tools.ts`**

Per Exact behavior + Interfaces. Keep every existing default path byte-identical (3-arg callers, F13 duration semantics).

- [ ] **Step 4: Run tests + build**

Run: `npx vitest run tests/agent-tools.test.ts && npx vitest run && npm run evals && npx tsc --noEmit -p tsconfig.json && npm run build && node --check dist/index.js`
Expected: PASS all green (suite + evals); build clean.

- [ ] **Step 5: Commit**

```bash
git add src/agent-tools.ts tests/agent-tools.test.ts dist/index.js
git commit -m "fix: deadline-aware tool execution with per-call byte caps (F11)"
```

---

### Task 60: F11 — agent loop and probe enforcement

**Files:**
- Modify: `src/agent.ts` (`AgentBudget.deadlineMs?`, `callWithDeadline` race, floor `timeoutFor`, per-call byte rules, `capToolResult` backstop replacing `capOutput`)
- Modify: `src/llm.ts` (probe-once `deadlineMs` in `callWithProbeAgent`)
- Test: `tests/agent.test.ts` (updates + new tests)
- Rebuild: `dist/index.js`

**Interfaces:**
- Consumes: Task 59's `executeTool` limits, `TRUNCATION_MARKER`, `ToolContext.ensureLinked` options.
- Produces: `AgentBudget.deadlineMs?: number` (absolute epoch-ms); `AgentHooks.callOpts` gains REQUIRED `deadlineMs: number` (`src/agent.ts:21` — every `hooks.call` implementer type; runtime implementers with fewer params, incl. `tests/evals/agent.test.ts:44`, are unaffected since extra args are ignored); `callWithDeadline(flags, opts, nowMs): Promise<{ reply: AgentReply; raced: boolean }>` (module-private, tested through `runAgent`); exported `capToolResult(output: string, maxBytes: number): string`.

**Exact behavior:**
- `runAgent` uses `budget.deadlineMs ?? start + maxSeconds * 1000`, reusing existing locals (no new `clock()` reads). All four `hooks.call` sites route through `callWithDeadline` with `nowMs` passed in (never read the clock inside the helper) and pass `{ timeoutSeconds, deadlineMs }` (absolute).
- `callWithDeadline`: `ms = deadline - nowMs`; `ms <= 0` → `{ reply: timeoutResult, raced: true }` WITHOUT invoking `hooks.call`; else `Promise.race` with a real-timer fallback resolving the same timeout result (`{ ok: false, result: { ok: false, reason: "timeout", detail: TIMEOUT_DETAIL } }`, reusing the constant); timer cleared on settle; dangling inner promise gets a noop-catch at race time. `raced === true` → `finish(timeout, "budget", false)` at every site; `false` flows through existing handling untouched.
- `timeoutFor` = `Math.max(1, Math.min(budget.timeoutSeconds, Math.floor(remaining / 1000)))`.
- Tool loop per call: run EVERY tool output (content and tool-error alike) through `capToolResult(output, effective)` where `effective = min(maxResultBytes, remaining)`; `remaining = maxTotalBytes - bytes` (`bytes` counts content outputs only — tool errors from `errorResult` count; loop-generated budget-exhausted/backstop/too-many-calls records, turn logs, `elapsedMs` excluded, each ≤ 65 B). `remaining < 12` (marker bytes) → skip execution, record `{"error":"tool result budget exhausted (max <maxTotalBytes> bytes)"}` with the number, do NOT increment `calls`; else `limits = { deadlineMs: Date.now() + max(0, deadline - clock()), maxResultBytes: min(maxResultBytes, remaining) }` (wall-clock conversion at the boundary — identity in production, consistent under fake clocks).
- `capToolResult`: JSON parses AND `byteLength <= maxBytes` → passthrough; else `{"error":"tool result exceeded the byte budget","truncated":true}` (exact, 65 B). Remove `capOutput`.
- Forced gate: `turns >= budget.maxTurns || bytes >= maxTotalBytes || (maxTotalBytes - bytes) < 12` (residue clause — a 1–11 B remainder forces instead of looping to `maxTurns`).
- `callWithProbeAgent` computes `Date.now() + maxSeconds * 1000` once, threads `deadlineMs` into every `runStyle` budget (explicit + probe). `agentCallFor` untouched. (Probe deadline is real-clock; loop tests use fake clocks around `runAgent` directly — no interaction.)
- Harness + existing-test updates (all three named, no others): `seenOpts` type gains `deadlineMs` (`tests/agent.test.ts:42,51`); `toEqual` assertions gain it — the `:170` floor case expects `{ timeoutSeconds: 50 }` → `{ timeoutSeconds: 50, deadlineMs: 1_060_000 }` (start 1_000_000 + 60 s); the `capOutput` surrogate test (`:267`) is replaced by backstop unit tests (below); `"forced final on bytes budget"` (`:138`, `maxTotalBytes: 10`) is updated to the new semantics — first iteration forces immediately (`remaining = 10 < 12`), so `calls` is `0` (was 1), `stop` stays `"budget"`, notes stay `[BUDGET_NOTE]`.

- [ ] **Step 1: Write the failing tests in `tests/agent.test.ts`** (harness: fake
  clock starts at `1_000_000`, `maxSeconds` default 120 → default deadline `1_120_000`;
  `okText`/`tc` helpers as today)

  - Pre-expired budget: `harness(root, [okText(FINDINGS)], { deadlineMs: 999_999 })`
    → `ncalls()` 0, `stop: "budget"`, `probeAdvance: false` (exercises the loop-level
    `timedOut` path).
  - `ms <= 0` without invoking `hooks.call`: scripted clock shifting through
    `[1_000_000 (start), 1_000_000 (loop-top check: 30 s remain, no timeout),
    1_031_000 (remaining read: past the deadline)]` and sticking on the last,
    with `{ maxSeconds: 30, deadlineMs: 1_030_000 }` → `ncalls()` 0, `stop: "budget"`.
  - Mid-call race win (fake timers, no live timing): `vi.useFakeTimers()`; hook
    `() => new Promise<AgentReply>(() => {})` (never settles); budget
    `{ maxSeconds: 30 }` (remaining 30 s ≥ the 10 s `timedOut` margin, so the call
    is reached; `timeoutFor` = 30). `const p = runAgent(...); await
    vi.advanceTimersByTimeAsync(30_000); const out = await p;` → `stop: "budget"`,
    `probeAdvance: false`; `vi.useRealTimers()` after. Far-future case: immediate
    hook + `{ maxSeconds: 3600 }` → normal handling (`stop: "final"`).
  - Floor pin: existing `:166` fixture + `deadlineMs: 1_060_000` in the `toEqual`.
  - Sub-marker skip: `maxTotalBytes: 10` (the updated `"forced final on bytes
    budget"` test) → first iteration forces (`remaining 10 < 12`): `calls` 0,
    `stop: "budget"`, notes `[BUDGET_NOTE]`.
  - Sub-envelope backstop: `a.txt` = `"hello\n"` (read output exactly 99 B, pinned
    by fixture) with `maxTotalBytes: 50` → remaining 50 ≥ 12 so the call executes
    with effective cap 50; the 99 B output exceeds it → recorded tool output is
    exactly `{"error":"tool result exceeded the byte budget","truncated":true}`,
    `bytes` stays 0 (`≤ total`), next reply `FINDINGS` → `stop: "final"`.
  - Multi-round exact totals + forced residue: `a.txt` = `"hello\n"`,
    `maxTotalBytes: 110`, replies `[read a.txt, read a.txt, FINDINGS]` → round 1
    `bytes` 99, remaining 11 `< 12` so round 2 forces (`BUDGET_NOTE`, no execution,
    `calls` stays 1) → forced-final `FINDINGS`, `stop: "budget"`, `bytes` 99.
  - Backstop unit tests (import `capToolResult` from `../src/agent.js`):
    passthrough (small valid JSON unchanged) / over-cap (→ exact envelope) /
    invalid-JSON (→ exact envelope) / multibyte-safe (emoji output over cap →
    envelope, no U+FFFD — supersedes the old `capOutput` surrogate test).
  - Mid-conversation expiry: scripted hook advancing the fake clock past the
    deadline mid-conversation → loop stops after the current turn (no further
    calls), `stop: "budget"`, `probeAdvance: false` (probe never advances).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/agent.test.ts`
Expected: FAIL (no `deadlineMs`, no race, old `capOutput`).

- [ ] **Step 3: Implement in `src/agent.ts` + `src/llm.ts`**

Per Exact behavior. Touch nothing else (probe order, 400/404 mapping, repair flow, note texts identical).

- [ ] **Step 4: Run tests + build**

Run: `npx vitest run tests/agent.test.ts tests/agent-tools.test.ts && npm run build && node --check dist/index.js && npm run evals && npx vitest run && npx tsc --noEmit -p tsconfig.json`
Expected: PASS all green (suite + evals); build clean.

- [ ] **Step 5: Commit**

```bash
git add src/agent.ts src/llm.ts tests/agent.test.ts dist/index.js
git commit -m "fix: whole-agent deadline and exact byte allowance (F11)"
```

---

### Task 61: F11 — deadline-aware linked clones

**Files:**
- Modify: `src/linked-repos.ts` (`deadlineMs?`, `effectiveTimeout`, expiry pre-checks, clamped calls, expired sentinel in `validateCache`)
- Modify: `src/main.ts` (closure takes `opts?` and forwards `opts?.deadlineMs` — param + line, one hunk at `:651`)
- Test: `tests/linked-repos.test.ts` (no `tests/main.test.ts` additions — the closure line is covered by type-check + review; its suite still runs in Step 4)
- Rebuild: `dist/index.js`

**Interfaces:**
- Consumes: Task 59's `ensureLinked(alias, opts?)` options type.
- Produces: `effectiveTimeout(configuredMs: number, endMs?: number, nowMs: number = Date.now()): number | "expired"` (exported for unit tests; the default keeps production call sites clean, tests pass `nowMs` explicitly); `ensureLinkedRepo` accepts `deadlineMs?: number` (absolute epoch, wall-clock `Date.now`); `validateCache` returns `string | null | "expired"` (distinct sentinel, never conflated with reclone-`null`).

**Exact behavior:**
- `effectiveTimeout`: no deadline → `configuredMs`; `endMs - nowMs <= 0` → `"expired"`; else `max(1, min(configuredMs, endMs - nowMs))` (floor 1 — bare 0 means no-timeout in `execFile`).
- `ensureLinkedRepo` entry pre-check FIRST (before `validateCache`, before `mkdir`): expired → `repository not accessible: <alias>: deadline exceeded` (exact detail text) with no `removeDir`/reclone/spawn. `validateCache` checks expiry at entry and returns `"expired"`; the caller maps it to the same error with no `removeDir` (a `null` still takes the existing removeDir+reclone path). Clone, `cloneHead`, and validation git calls take `effectiveTimeout` values; ANY `"expired"` mid-flow aborts with the error immediately — no further spawns, no wipe of an existing dir (replaces the old reclone-then-fail-fast residual).
- `sizeKb` lookup untouched (explicitly out of scope).
- `main.ts` closure: `(alias, opts?)` + `deadlineMs: opts?.deadlineMs` in the `ensureLinkedRepo` args (covered by type-check + review — no dedicated seam exists for the inline closure; state that in the report).

- [ ] **Step 1: Write the failing tests in `tests/linked-repos.test.ts`** (deps.run
  fakes recording calls, real short timeouts; all `effectiveTimeout` cases pass
  `nowMs` explicitly — no clocks, no spies)

  - Unit table (pick `now = 1_000_000`): `(60000, undefined, now)` → `60000`;
    `(60000, now + 5000, now)` → `5000`; `(60000, now - 1, now)` → `"expired"`;
    `(60000, now, now)` → `"expired"`; `(60000, now + 1, now)` → `1` (floor pin).
  - Expired deadline on a missing dir → error containing `deadline exceeded` +
    `deps.run` uncalled (assert the recorded-calls array is empty).
  - Pre-seeded plain dir (no `.git`, so the non-deadline path would
    removeDir+reclone) + expired deadline → same error + dir still exists (no wipe).
  - In `tests/main.test.ts`: nothing new (closure covered by type-check + review).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/linked-repos.test.ts`
Expected: FAIL (no `deadlineMs`, no helper).

- [ ] **Step 3: Implement in `src/linked-repos.ts` + closure param/line in `src/main.ts`**

Per Exact behavior. Touch nothing else.

- [ ] **Step 4: Run tests + build**

Run: `npx vitest run tests/linked-repos.test.ts tests/main.test.ts && npm run build && node --check dist/index.js && npm run evals && npx vitest run && npx tsc --noEmit -p tsconfig.json`
Expected: PASS all green (suite + evals); build clean.

- [ ] **Step 5: Commit**

```bash
git add src/linked-repos.ts src/main.ts tests/linked-repos.test.ts dist/index.js
git commit -m "fix: deadline-aware linked clones without cache wipes (F11)"
```
