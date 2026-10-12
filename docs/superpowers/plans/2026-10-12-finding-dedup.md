# Finding-dedup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The LLM judges duplicate findings via response verdicts; deterministic code merges them with visible, tested rules.

**Architecture:** Task 67 plumbs verdicts (schema, parser, LlmResult, adapters); Task 68 merges (caps move, merge function, slowPath/publishReview wiring, verdicts.json, Flow B). Sequential (67 → 68). (First follow-up of the Q02/Q04/Q01/dedup order; each of the others gets its own cycle later.)

**Tech Stack:** TypeScript 5.x, Node >=24, vitest, esbuild (`dist/` committed).

**Spec:** `docs/superpowers/specs/2026-10-12-finding-dedup-design.md`

## Global Constraints

- No new runtime dependencies, no new action inputs, no template or CI changes.
- `PR_REVIEWER_*` env names, `pr-reviewer-*` strings, `pr-reviewer/1.0` user-agent, SARIF driver name, `lupa:` log prefixes unchanged.
- Every task ends with `npx tsc --noEmit -p tsconfig.json`, `npm run build && node --check dist/index.js` and commits `dist/index.js`.
- Full suite (`npx vitest run`) + evals (`npm run evals`) green before every task commit (evals after build).
- Commit messages use the exact strings given per task.
- Ships with the next release vehicle — no tag alone.

## Review Focus

- **Verdicts referencing F10-cut tail indices are dropped with a warning; all findings kept.** Test in Task 68's step style (oversized fast list, pair into the cut tail).
- **Agent-mode findings never merge even when duplicated.** Test in Task 68's step style (agent-shaped duplicate content → two comments).
- **A Flow B artifact without the verdicts key still posts unmerged.** Test in Task 68's step style (missing key → silent no-merge, review posted).
- **A model finding linked to a scanner finding merges into one comment citing both rules.** Test in Task 68's step style.
- **A merged high+warning still gates REQUEST_CHANGES/1.** Test in Task 68's step style (gate-equivalence fixture).

---

### Task 67: Dedup verdict plumbing (schema, parser, transport)

**Files:**
- Modify: `src/prompt.ts` (schema + IDs/instructions at the single-shot call site only), `src/llm.ts` (`DedupVerdicts`, `parseVerdicts`, `LlmResult.verdicts`), `src/adapters/messages.ts:240`, `src/adapters/responses.ts:246`, `src/adapters/google.ts:391`, `src/llm.ts:409` (attach `verdicts: parseVerdicts(parsed)`; `agent.ts:62` untouched by design)
- Test: `tests/llm.test.ts` (parse units via `okChat` content + callLlm pins), `tests/prompt.test.ts` (required-list + `Object.keys` pins), `tests/adapters-google.test.ts` (converted-schema expectation incl. `minItems`/`maxItems` passthrough + 6 toEqual pins), `tests/adapters-messages.test.ts`, `tests/adapters-responses.test.ts`, `tests/adapters-routing.test.ts`, `tests/agent-probe.test.ts`, `tests/probe-routing.test.ts` (toEqual pins gain `verdicts`)
- Rebuild: `dist/index.js`

**Interfaces:**
- Consumes: existing `parseContent`/`toFindings` (untouched), `okChat(content, extra)` helper, shared `buildMessages`/`budgetPrompt` (signatures extended, behavior default-off).
- Produces: `interface DedupVerdicts { pairs: Array<[number, number]>; links: Array<[number, number]>; malformed: number }` (links response-relative OUT of `parseVerdicts`, absolute at CONSUMPTION after `slowPath` converts); `parseVerdicts(parsed: unknown): DedupVerdicts`; `LlmResult.verdicts?: DedupVerdicts` (absent = none; evals mocks compile unchanged); `DEDUP_INSTRUCTIONS: string` (exported const, prompt.ts — names the `duplicates`/`duplicateOf` fields, 0-based indices, pair arrays); `buildMessages`/`budgetPrompt` trailing `opts?: { withIds?: boolean }` (default off).

**Exact behavior:**
- Schema: top-level `duplicates` + per-item `duplicateOf`, both `{type: [<t>, "null"]}` with `items: {type:"integer"}` + `minItems: 2, maxItems: 2` on the pairs array (NO `prefixItems` — length-checked in the parser; keeps every adapter converter untouched); both keys in their `required` lists. IDs + verdict instructions render ONLY in the single-shot message path: `slowPath` passes `{ withIds: true }` through `budgetPrompt` into `buildMessages` (ID bytes move the cut point); the agent-mode branch rebuilds its messages without IDs (fewer bytes than measured — still within budget); `DEDUP_INSTRUCTIONS` is appended to the system text at the single-shot invocations only. `withIds: true` adds an `"id"` field FIRST (`{id, ...f}`) to each sent finding object with ALL other fields complete and untruncated (full message + suggestion bodies).
- `parseVerdicts(parsed)`: null/absent keys → empty verdicts, `malformed: 0`; drops negativity/non-integer indices, self-pairs, dangling pointers, non-pairs, wrong-length pairs (each drop `malformed++`). Fence handling inherited from the single `parseContent` call upstream (no double parse).
- Adapters + `llm.ts:409` (`return` line; `toFindings` at `:405`): `return { ok: true, findings, verdicts: parseVerdicts(parsed) }` (`parsed` is the in-scope variable at all four sites). `agent.ts:62` untouched (no verdicts by design).

- [ ] **Step 1: Write the failing tests**
  - `tests/llm.test.ts` via `okChat` content: pairs + pointers extracted; null/absent → empty; unknown/self/malformed dropped with counts; wrong-length pair dropped.
  - `tests/prompt.test.ts`: required lists include the new keys (update existing pins, incl. the `Object.keys(item.properties)` pin); `withIds: true` renders `"id":<n>` FIRST alongside complete message/suggestion bodies, instructions name `duplicates`/`duplicateOf` + 0-based indices + pair arrays; default/`withIds` absent renders no `id` fields (agent path unchanged). `budgetPrompt` without opts measures exactly as today (existing cut-point tests untouched).
  - `tests/adapters-google.test.ts`: converted expectation gains the nullable `duplicates`/`duplicateOf` (via `googleSchema` recursion + `nullable: true`, `minItems`/`maxItems` passed through).
  - `toEqual` pins carrying `{ ok: true, findings: [...] }` gain the `verdicts` key: `tests/adapters-messages.test.ts`, `tests/adapters-responses.test.ts`, `tests/adapters-routing.test.ts`, `tests/agent-probe.test.ts`, `tests/probe-routing.test.ts`, `tests/llm.test.ts` callLlm pins (suite pinpoints any other).
  - Probe: extend one `callWithProbe` routing test (scripted 400-then-ok) asserting the WINNING style's verdicts surface and the loser's do not.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/llm.test.ts tests/prompt.test.ts tests/adapters-google.test.ts`
Expected: FAIL (no verdicts).

- [ ] **Step 3: Implement**

Per Exact behavior + Interfaces. `toFindings`, `sanitizeFinding`, agent path untouched.

- [ ] **Step 4: Run tests + build**

Run: `npx vitest run tests/llm.test.ts tests/prompt.test.ts tests/adapters-google.test.ts && npx tsc --noEmit -p tsconfig.json && npm run build && node --check dist/index.js && npm run evals && npx vitest run`
Expected: PASS all green (evals after build); build clean.

- [ ] **Step 5: Commit**

```bash
git add src/prompt.ts src/llm.ts src/adapters/messages.ts src/adapters/responses.ts src/adapters/google.ts tests/llm.test.ts tests/prompt.test.ts tests/adapters-google.test.ts tests/adapters-messages.test.ts tests/adapters-responses.test.ts tests/adapters-routing.test.ts tests/agent-probe.test.ts tests/probe-routing.test.ts dist/index.js
git commit -m "feat: LLM duplicate verdicts in schema, parser, and transport"
```

---

### Task 68: Deterministic merge and flow wiring

**Files:**
- Modify: `src/fastpath.ts` (receive `MSG_CAP`, `RULE_CAP`, `TRUNC_MARK`, `capText` — main.ts imports them; behavior unchanged), `src/review.ts` (`mergeDuplicates`), `src/main.ts` (slowPath envelope + absolute conversion + warnings, `PublishArgs.verdicts`, `publishReview` merge, `PrMeta.verdicts` write/read, sarif from merged, Flow B, no-LLM `note()`), `src/diff.ts` (`PrMeta.verdicts?: DedupVerdicts` + `readPrMeta` return + shape validation), `README.md` (dedup section + `:155` "no cross-scanner dedupe" rewrite)
- Test: `tests/review.test.ts` (merge units), `tests/main.test.ts` (flows), `tests/fastpath.test.ts` (caps move is transparent — no new tests), `tests/diff.test.ts` (verdicts round-trip through pr-meta; malformed verdicts throw like any contract violation)
- Rebuild: `dist/index.js`

**Interfaces:**
- Consumes: Task 67's `DedupVerdicts` (with `malformed`), `parseVerdicts`, `LlmResult.verdicts`.
- Produces: `mergeDuplicates(findings: Finding[], verdicts: DedupVerdicts): { merged: Finding[]; dropped: number }` (pure; out-of-range indices dropped + counted); `PrMeta.verdicts?: DedupVerdicts` (Flow B reads it; missing = no judge ran).

**Exact behavior:**
- `mergeDuplicates`: check-then-union ORDER — same-file + line-compatible precondition tested PER PAIR/LINK before closure (A~B valid + B~C cross-file → C stays alone, A+B merge; e.g. pinned in test); transitive closure over ABSOLUTE positions; partial pairs dropped whole; survivor (first-member-position order): defined file/line, distinct rules `"+"`-joined then `RULE_CAP`-recapped, severity max, `` `[rule] message` `` `"\n\n"`-joined then message-recapped, first defined suggestion; unmergeable (incl. out-of-range) counted in `dropped`.
- `slowPath` returns `{ findings, verdicts? } | undefined` (agent return: verdicts absent); converts links to absolute (`fast.length + r`); drops verdicts with sent index ≥ `b.fast.length` (cut tail — unseen by construction) counting them into `malformed`; warns `lupa: ignored <n> malformed dedup verdict(s)` iff `malformed > 0`. Caller `:970` destructures (`llm?.findings ?? []`, verdicts pass-through); `findingsFrom` logic unchanged.
- Flow A writes pre-merge `findings.json` + rewrites `pr-meta.json` WITH verdicts after the slow path (always — even `{pairs: [], links: [], malformed: 0}`); `readPrMeta` returns the validated verdicts (present-but-malformed shape throws like any pr-meta violation; missing key = silent no-merge). `PublishArgs.verdicts?`; `publishReview`: gates/summary/dry-run on fullSet, `merged` for funnel with omission counts from MERGED lengths (`merged.length − topN.length`; merged-away are represented, never omitted), NO return-type change; `dropped > 0` → `core.warning("lupa: ignored <n> unmergeable dedup verdict(s)")`; sarif from a `mergeDuplicates(redacted, verdicts)` call in `runFlowA` (same pure inputs as the funnel merge — identical result, never on already-merged output). Flow B reads verdicts from `pr-meta.json` (missing key → silent no-merge), then the same point. Agent path: no verdicts, no merge, no note (by design).
- No-LLM skip: `note()` in `runFlowA` at the `:970` call site when `llm === undefined` (existing summary assertions may gain the appended line — suite pinpoints; update as named). README dedup section + `:155` rewrite (dedupe now exists via this design).
- F15 compatibility: existing F15 tests run unchanged (assert in the report, no new tests).

- [ ] **Step 1: Write the failing tests**
  - `tests/review.test.ts`: canary pair → one (high, collapsed rule, redacted kept); `duplicateOf` link (absolute index); transitive triple; cross-file ignore + count (A~B merges while B~C cross-file leaves C alone); partial drop; out-of-range drop; rule re-cap; message re-cap; order stability; empty verdicts passthrough.
  - `tests/main.test.ts`: slowPath envelope + absolute conversion + malformed warning (incl. cut-tail drop: N fast findings with computed `maxPromptChars` so kept==K — measure serialized sizes in-test — pair `[0,K]` dropped with warning, all kept); empty-verdicts publishReview output equals the unmerged funnel output (byte-identical — merge is a no-op without verdicts); Flow A pr-meta carries verdicts (incl. empty-verdicts case); publishReview merge before funnel with gates/summary/dry-run on fullSet; sarif count == merged; F15 marker counts on the merged set (omitted reflects post-merge top-N cut); Flow B twin via pr-meta verdicts fixture + missing-key silent passthrough; agent duplicates unmerged; high+warning gate-equivalence; no-LLM exact note via `note()`.
  - `tests/diff.test.ts`: pr-meta verdicts round-trip (unknown keys still lenient).
  - F15 compatibility: existing F15 tests run unchanged (assert in the report, no new tests).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/review.test.ts tests/main.test.ts`
Expected: FAIL (no merge).

- [ ] **Step 3: Implement**

Per Exact behavior + Interfaces. `mapToComments`/`buildBody`/`buildFallbackReport`/`eventFor`/`exitFor` bodies untouched.

- [ ] **Step 4: Run tests + build**

Run: `npx vitest run tests/review.test.ts tests/main.test.ts && npx tsc --noEmit -p tsconfig.json && npm run build && node --check dist/index.js && npm run evals && npx vitest run`
Expected: PASS all green (evals after build, F15 tests included); build clean.

- [ ] **Step 5: Commit**

```bash
git add src/fastpath.ts src/review.ts src/main.ts src/diff.ts README.md tests/review.test.ts tests/main.test.ts tests/diff.test.ts dist/index.js
git commit -m "fix: merge LLM-judged duplicate findings deterministically"
```
