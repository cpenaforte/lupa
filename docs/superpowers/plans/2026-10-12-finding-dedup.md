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
- **A Flow B artifact without verdicts.json still posts unmerged.** Test in Task 68's step style (missing file → silent no-merge, review posted).
- **A model finding linked to a scanner finding merges into one comment citing both rules.** Test in Task 68's step style.
- **A merged high+warning still gates REQUEST_CHANGES/1.** Test in Task 68's step style (gate-equivalence fixture).

---

### Task 67: Dedup verdict plumbing (schema, parser, transport)

**Files:**
- Modify: `src/prompt.ts` (schema + IDs/instructions at the single-shot call site only), `src/llm.ts` (`DedupVerdicts`, `parseVerdicts`, `LlmResult.verdicts`), `src/adapters/messages.ts:236`, `src/adapters/responses.ts:242`, `src/adapters/google.ts:387`, `src/llm.ts:405` (attach `verdicts: parseVerdicts(text)`; `agent.ts:62` untouched by design)
- Test: `tests/llm.test.ts` (parse units via `okChat` content), `tests/prompt.test.ts` (required-list pins), `tests/adapters-google.test.ts` (converted-schema expectation)
- Rebuild: `dist/index.js`

**Interfaces:**
- Consumes: existing `parseContent`/`toFindings` (untouched), `okChat(content, extra)` helper, shared `buildMessages` (signature extended, behavior default-off).
- Produces: `interface DedupVerdicts { pairs: Array<[number, number]>; links: Array<[number, number]> }` (absolute all-indices at CONSUMPTION; `parseVerdicts` returns response-relative links, `slowPath` converts in Task 68); `parseVerdicts(rawText: string): { verdicts: DedupVerdicts; malformed: number }`; `LlmResult.verdicts?: DedupVerdicts` (absent = none; evals mocks compile unchanged); `DEDUP_INSTRUCTIONS: string` (exported const, prompt.ts — contains the words "duplicates" and "same evidence"); `buildMessages` trailing `opts?: { withIds?: boolean }` (default off).

**Exact behavior:**
- Schema: top-level `duplicates` + per-item `duplicateOf`, both `{type: [<t>, "null"]}` with `items: {type:"integer"}` + `minItems: 2, maxItems: 2` on the pairs array; both keys in their `required` lists. IDs + verdict instructions render ONLY in the single-shot message path: `withIds: true` adds an `"id"` field (the array index) to each sent finding object with ALL other fields complete and untruncated (full message + suggestion bodies — the model reasons on substantive content, never bare IDs); agent path passes nothing (prompts byte-identical there).
- `parseVerdicts`: null/absent keys → empty verdicts, `malformed: 0`; drops unknown indices (no size reference available here — negativity/non-integer only), self-pairs, dangling pointers (duplicateOf without a matching response finding is decided by the CALLER holding both arrays — see Task 68; here: keep link iff its response position exists), non-pairs, wrong-length pairs (each drop `malformed++`).
- Adapters + `llm.ts:405`: `return { ok: true, findings, verdicts: parseVerdicts(text) }` (variable is named `text` at all four sites).

- [ ] **Step 1: Write the failing tests**
  - `tests/llm.test.ts` via `okChat` content: pairs + pointers extracted; null/absent → empty; unknown/self/malformed dropped with counts; wrong-length pair dropped.
  - `tests/prompt.test.ts`: required lists include the new keys (update existing pins); `withIds: true` renders `"id":<n>` alongside complete message/suggestion bodies, instructions contain "duplicates" + "same evidence"; default/`withIds` absent renders no `id` fields (agent path unchanged).
  - `tests/adapters-google.test.ts`: converted expectation gains the nullable `duplicates`/`duplicateOf` (via `googleSchema` recursion + `nullable: true`).

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
git add src/prompt.ts src/llm.ts src/adapters/messages.ts src/adapters/responses.ts src/adapters/google.ts tests/llm.test.ts tests/prompt.test.ts tests/adapters-google.test.ts dist/index.js
git commit -m "feat: LLM duplicate verdicts in schema, parser, and transport"
```

---

### Task 68: Deterministic merge and flow wiring

**Files:**
- Modify: `src/fastpath.ts` (receive `MSG_CAP`, `RULE_CAP`, `TRUNC_MARK`, `capText` — main.ts imports them; behavior unchanged), `src/review.ts` (`mergeDuplicates`), `src/main.ts` (slowPath envelope + absolute conversion + warnings, `PublishArgs.verdicts`, `publishReview` merge + return, `verdicts.json` write/read, sarif from merged, Flow B, README note), `README.md` (dedup section: no-LLM behavior)
- Test: `tests/review.test.ts` (merge units), `tests/main.test.ts` (flows), `tests/fastpath.test.ts` (caps move is transparent — no new tests)
- Rebuild: `dist/index.js`

**Interfaces:**
- Consumes: Task 67's `DedupVerdicts`, `parseVerdicts`, `LlmResult.verdicts`.
- Produces: `mergeDuplicates(findings: Finding[], verdicts: DedupVerdicts): { merged: Finding[]; dropped: number }` (pure; out-of-range indices dropped + counted); `publishReview` returns `Promise<{ merged: Finding[] }>`; `verdicts.json` artifact `{pairs, links}`.

**Exact behavior:**
- `mergeDuplicates`: transitive closure over ABSOLUTE positions; same-file + line-compatible precondition (else drop+count); partial pairs dropped whole; survivor (first-member-position order): defined file/line, distinct rules `"+"`-joined then `RULE_CAP`-recapped, severity max, `` `[rule] message` `` `"\n\n"`-joined then message-recapped, first defined suggestion; unmergeable (incl. out-of-range) counted in `dropped`.
- `slowPath` returns `{ findings, verdicts } | undefined` (agent return: verdicts absent); converts links to absolute (`fast.length + r`); warns `lupa: ignored <n> malformed dedup verdict(s)` iff `malformed > 0`. Caller `:970` destructures (`llm?.findings ?? []`, verdicts pass-through); `findingsFrom` logic unchanged.
- Flow A writes pre-merge `findings.json` + always-written `verdicts.json` (even empty). `PublishArgs.verdicts?`; `publishReview`: gates/summary/dry-run on fullSet, `merged` for funnel, returns `{ merged }`; `dropped > 0` → `core.warning("lupa: ignored <n> unmergeable dedup verdict(s)")`; sarif from returned merged. Flow B reads `verdicts.json` best-effort under the F15 read cap (missing/malformed → no merge, no warning for missing, warning for malformed) then the same point. Agent path: no verdicts, no merge, no note (by design).
- No-LLM skip: existing `note()` paths gain the exact dedup line from the spec (fires on ANY slow-path skip).

- [ ] **Step 1: Write the failing tests**
  - `tests/review.test.ts`: canary pair → one (high, collapsed rule, redacted kept); `duplicateOf` link; transitive triple; cross-file ignore + count; partial drop; out-of-range drop; rule re-cap; message re-cap; order stability; empty verdicts passthrough.
  - `tests/main.test.ts`: slowPath envelope + absolute conversion + malformed warning; Flow A verdicts.json written (incl. empty-verdicts case); publishReview merge before funnel with gates/summary/dry-run on fullSet; sarif count == merged; Flow B twin via verdicts.json fixture + missing-file silent passthrough; cut-tail pair dropped; agent duplicates unmerged; high+warning gate-equivalence; no-LLM exact note.
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
git add src/fastpath.ts src/review.ts src/main.ts README.md tests/review.test.ts tests/main.test.ts dist/index.js
git commit -m "fix: merge LLM-judged duplicate findings deterministically"
```
