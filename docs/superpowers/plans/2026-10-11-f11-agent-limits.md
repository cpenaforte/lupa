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
- **Existing fake-clock loop tests keep passing; only the named `seenOpts`/`toEqual` update and the surrogate-test replacement change.** Test in Task 60's step style (full suite green + the two named updates).
- **Mid-conversation expiry stops the loop after the current turn**, never mid-turn and never advancing the probe. Test in Task 60's step style (advancing fake clock).
- **A sub-marker remainder skips instead of emitting a corrupt micro-output.** Test in Task 60's step style (tiny total budget, second call skipped with the exact error, `calls` unmoved).
- **An expired clone validation never wipes a valid cache dir.** Test in Task 61's step style (plain dir + expired deadline → error + dir intact).

---

### Task 59: F11 — tool-layer deadlines and byte caps

**Files:**
- Modify: `src/agent-tools.ts` (`executeTool` limits, grep `endMs`/recompute, walk conversions, per-tool caps, `errorResult` cap, `TRUNCATION_MARKER` export, `resolveRoot`/`rootFor`/`ensureLinked` threading)
- Test: `tests/agent-tools.test.ts`
- Rebuild: `dist/index.js`

**Interfaces:**
- Consumes: F13 `WalkLimits`/`walkFiles`/`walkPaths`/`grepInRoot` (durations; absolute→duration conversion lives here).
- Produces: `executeTool(name, args, ctx, limits?: { deadlineMs?: number; maxResultBytes?: number })` (`deadlineMs` absolute epoch, `maxResultBytes` per-call cap); exported `TRUNCATION_MARKER` (the existing `"\n[truncated]"` literal, 12 bytes); `ToolContext.ensureLinked(alias, opts?: { deadlineMs?: number })`; `grepInRoot(root, args, timeoutMs?, limits?, endMs?)`; per-tool `maxBytes` trailing params.

**Exact behavior:**
- `deadlineMs` conversions: `walk` duration `min(WALK_DEFAULT_DEADLINE_MS, max(0, end-now))`; grep worker recomputed post-walk as `min(GREP_TIMEOUT_MS, max(0, end-now))` (expired → timeout error, no spawn); entry-expired (`end-now <= 0`) returns the existing timeout/error result before any walk/spawn. `read_file`/`list_dir` ignore deadlines (sync bounded work).
- Per-tool caps via trailing `maxBytes` (default `AGENT_LIMITS.resultBytes` 32768): `read_file`/`grep` parameterize existing marker-inside logic; `list_dir`/`glob` drop tail entries (`truncated` stays true); `errorResult` caps at `ERROR_MESSAGE_CAP = 2000` with marker inside.
- `resolveRoot(repo, ctx, deadlineMs?)` / `rootFor(args, ctx, deadlineMs?)` forward into `ensureLinked(alias, { deadlineMs })`; `read_file`'s 1 MiB refusal and confinement checks run before any deadline logic (unchanged order).

- [ ] **Step 1: Write the failing tests in `tests/agent-tools.test.ts`**

```ts
it("expired deadlineMs fails fast without walking or spawning", async () => {
  const ctx = ctxFor(root); // existing helper
  const g = await executeTool("grep", { pattern: "x" }, ctx, { deadlineMs: 1 });
  expect(JSON.parse(g.output)).toMatchObject({ isError: undefined }); // shape TBD by impl — assert timeout error text via toContain("timed out")
  const gl = await executeTool("glob", { pattern: "**/*" }, ctx, { deadlineMs: 1 });
  expect(gl.isError).toBe(true);
});
it("huge deadlineMs behaves exactly as today", async () => {
  const ctx = ctxFor(rootWithFiles);
  const g = await executeTool("grep", { pattern: "keep" }, ctx, { deadlineMs: Date.now() + 3600000 });
  expect(JSON.parse(g.output).matches.length).toBeGreaterThan(0);
});
it("per-tool maxResultBytes caps output with the marker inside", async () => {
  const r = await executeTool("read_file", { path: "big-ish.txt" }, ctxFor(root), { maxResultBytes: 100 });
  const p = JSON.parse(r.output);
  expect(Buffer.byteLength(r.output, "utf8")).toBeLessThanOrEqual(100);
  expect(p.content).toContain("[truncated]");
});
it("resolveRoot forwards the deadline to ensureLinked", async () => {
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
- Produces: `AgentBudget.deadlineMs?: number` (absolute epoch-ms); `callWithDeadline(flags, opts, nowMs): Promise<{ reply: AgentReply; raced: boolean }>` (module-private, tested through `runAgent`); exported `capToolResult(output: string, maxBytes: number): string`.

**Exact behavior:**
- `runAgent` uses `budget.deadlineMs ?? start + maxSeconds * 1000`, reusing existing locals (no new `clock()` reads). All four `hooks.call` sites route through `callWithDeadline` with `nowMs` passed in (never read the clock inside the helper).
- `callWithDeadline`: `ms = deadline - nowMs`; `ms <= 0` → `{ reply: timeoutResult, raced: true }` WITHOUT invoking `hooks.call`; else `Promise.race` with a real-timer fallback resolving the same timeout result (`{ ok: false, result: { ok: false, reason: "timeout", detail: TIMEOUT_DETAIL } }`, reusing the constant); timer cleared on settle; dangling inner promise gets a noop-catch at race time. `raced === true` → `finish(timeout, "budget", false)` at every site; `false` flows through existing handling untouched.
- `timeoutFor` = `Math.max(1, Math.min(budget.timeoutSeconds, Math.floor(remaining / 1000)))`.
- Tool loop per call: `remaining = maxTotalBytes - bytes` (`bytes` counts content outputs only); `remaining < 12` (marker bytes) → skip execution, record `{"error":"tool result budget exhausted (max <maxTotalBytes> bytes)"}` with the number, do NOT increment `calls`; else `limits = { deadlineMs: Date.now() + max(0, deadline - clock()), maxResultBytes: min(maxResultBytes, remaining) }` (wall-clock conversion at the boundary — identity in production, consistent under fake clocks).
- `capToolResult`: JSON parses AND `byteLength <= maxBytes` → passthrough; else `{"error":"tool result exceeded the byte budget","truncated":true}` (exact). Remove `capOutput`.
- `callWithProbeAgent` computes `Date.now() + maxSeconds * 1000` once, threads `deadlineMs` into every `runStyle` budget (explicit + probe). `agentCallFor` untouched.
- `seenOpts` `toEqual` gains `deadlineMs`; the `capOutput` surrogate test is replaced by backstop unit tests (passthrough / over-cap / invalid-JSON / multibyte-safe).

- [ ] **Step 1: Write the failing tests in `tests/agent.test.ts`**

Pre-expired budget (no `hooks.call`, `stop: "budget"`); advancing-clock mid-conversation stop; fake-timer race win (`stop: "budget"`) + far-future normal path; floor pin (`timeoutSeconds === 10` at 10,500 ms remaining in `seenOpts`); tiny-total skip (exact exhausted error, `calls` unmoved, output ≤ total); backstop unit tests (import `capToolResult` from `../src/agent.js`); multi-round exact totals + forced next round.

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
- Modify: `src/main.ts` (closure forwards `opts?.deadlineMs` — one line)
- Test: `tests/linked-repos.test.ts`, `tests/main.test.ts` (closure line is type-checked + reviewer-verified; no dedicated seam test — see below)
- Rebuild: `dist/index.js`

**Interfaces:**
- Consumes: Task 59's `ensureLinked(alias, opts?)` options type.
- Produces: `effectiveTimeout(configuredMs: number, endMs?: number): number | "expired"` (exported for unit tests); `ensureLinkedRepo` accepts `deadlineMs?: number` (absolute epoch, wall-clock `Date.now`).

**Exact behavior:**
- `effectiveTimeout`: no deadline → `configuredMs`; `endMs - Date.now() <= 0` → `"expired"`; else `max(1, min(configuredMs, remaining))` (floor 1 — bare 0 means no-timeout in `execFile`).
- `ensureLinkedRepo` entry pre-check: expired → `repository not accessible: <alias>: deadline exceeded` (exact detail text) WITHOUT `removeDir`/reclone/spawn. `validateCache` checks expiry at entry and returns `"expired"` (extend its return to `string | null | "expired"`); the caller maps it to the same error with no `removeDir`. Mid-validation expiry may still reclone-then-fail-fast (bounded, stated residual — each clamped call fails fast, final error identical).
- Clone, `cloneHead`, and validation git calls use `effectiveTimeout` values. `sizeKb` lookup untouched (explicitly out of scope).
- `main.ts` closure: `deadlineMs: opts?.deadlineMs` added to the `ensureLinkedRepo` args (one line; covered by type-check + review — no dedicated seam exists for the inline closure).

- [ ] **Step 1: Write the failing tests**

In `tests/linked-repos.test.ts` (deps.run fakes, real short timeouts): `effectiveTimeout` unit table (no deadline → configured; future → min; past → `"expired"`; sub-ms remaining → 1); expired deadline on missing dir → error containing `deadline exceeded` + `deps.run` uncalled; pre-seeded plain dir + expired deadline → same error + dir still exists (no wipe); 1 ms fake proves the floor spawns.
In `tests/main.test.ts`: none new (closure line covered by type-check + review; state that in the report).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/linked-repos.test.ts`
Expected: FAIL (no `deadlineMs`, no helper).

- [ ] **Step 3: Implement in `src/linked-repos.ts` + one line in `src/main.ts`**

Per Exact behavior. Touch nothing else.

- [ ] **Step 4: Run tests + build**

Run: `npx vitest run tests/linked-repos.test.ts tests/main.test.ts && npm run build && node --check dist/index.js && npm run evals && npx vitest run && npx tsc --noEmit -p tsconfig.json`
Expected: PASS all green (suite + evals); build clean.

- [ ] **Step 5: Commit**

```bash
git add src/linked-repos.ts src/main.ts tests/linked-repos.test.ts dist/index.js
git commit -m "fix: deadline-aware linked clones without cache wipes (F11)"
```
