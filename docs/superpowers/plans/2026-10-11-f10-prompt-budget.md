# F10 prompt budget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce a whole-request byte budget on the single-shot LLM prompt with structured cuts, explicit omission records, and sanitized evidence.

**Architecture:** Task 57 builds the pure pieces (new input plumbing, `buildMessages` renderer extensions); Task 58 wires the budget decision (`budgetPrompt` + single slow-path assembly + prompt-only sanitize copy). Each task is independently testable and committable.

**Tech Stack:** TypeScript 5.x, Node >=24, vitest, esbuild (`dist/` committed).

**Spec:** `docs/superpowers/specs/2026-10-11-f10-prompt-budget-design.md`

## Global Constraints

- No new runtime dependencies (node builtins + existing deps only). Exactly one new action input (`max_prompt_chars`, optional). `PR_REVIEWER_*` env names, `pr-reviewer-*` concurrency/artifact strings, `pr-reviewer/1.0` user-agent, SARIF driver name, and `lupa:` log prefixes stay unchanged.
- Every task ends with `npx tsc --noEmit -p tsconfig.json`, `npm run build && node --check dist/index.js` and commits `dist/index.js`.
- Full suite (`npx vitest run`) green before every task commit; no test deleted without a replacement asserting the new contract. Full eval suite (`npm run evals`) green — artifacts byte-identical by construction.
- Commit messages use the exact strings given per task.
- Ships with the whole-plan release — no tag for F10 alone.

## Review Focus

- **A CJK-heavy diff at default caps must skip** (bytes over budget though units fit) — intended behavior, pinned so the unit fix cannot regress. Test in Task 58's step style.
- **An over-budget prompt must never reach the probe** — every skip path warns with both sizes and makes no LLM call. Test in Task 58's step style.
- **Omitted findings still reach posting/artifacts** — the cut affects model context only. Test in Task 58's step style (posted review contains the dropped finding).
- **Existing suite fixtures stay green untouched** (default 120,000 dwarfs them; sanitized-copy design leaves artifacts byte-identical). Verified by running, not by editing fixtures.
- **`max_prompt_chars: 0`/negative/non-numeric are rejected naming the input** (readInt floor 1 = minimum accepted, never a clamp). Test in Task 57's step style.

---

### Task 57: F10 — input plumbing + renderer extensions

**Files:**
- Modify: `action.yml` (new input after `max_diff_chars`)
- Modify: `src/inputs.ts` (`ActionInputs.maxPromptChars` + `readInt` line)
- Modify: `src/prompt.ts` (`buildMessages` 6th param `omitted = 0`; skipped-list 20-cap; export `neutralise` + issue header/tags/marker constants)
- Modify: `README.md` (input row + Cost ceiling update per spec figures)
- Test: `tests/inputs.test.ts` (`INPUT_NAMES`, default, reject cases), `tests/smoke.test.ts` (declared-inputs list), `tests/prompt.test.ts` (renderer tests), `tests/readme.test.ts` (only if the Cost edit breaks a pin — check first), `tests/main.test.ts:173` + `tests/evals/harness.ts:32` (add the field)

**Interfaces:**
- Consumes: `readInt(name, fallback, min)` pattern (`src/inputs.ts:70`).
- Produces: `ActionInputs.maxPromptChars: number`; `buildMessages(fast, promptText, issueBody, skipped, agent?, omitted?: number)`; exported `neutralise(text: string): string` + `LINKED_ISSUE_HEADER`, `LINKED_ISSUE_OPEN`, `LINKED_ISSUE_CLOSE`, `ISSUE_TRUNCATION_MARKER` constants (exact strings from current literals).

**Exact behavior:**
- `action.yml`: `max_prompt_chars` after `max_diff_chars`, `required: false`, `default: "120000"`, description per spec (both-paths wording, unit note).
- `inputs.ts`: `maxPromptChars: readInt("max_prompt_chars", 120000, 1)` after the `maxDiffChars` line.
- `buildMessages`: 6th param `omitted: number = 0`; when > 0 renders `\n\nOmitted <M> fast finding(s) to fit the prompt budget.` after the findings JSON; skipped-file list capped at 20 entries + `\n- …and <N> more omitted from this note` line. Existing 4-/5-arg behavior byte-identical.
- README: input documented beside `max_diff_chars` with the bytes-vs-units note; Cost ceiling bullet names `max_prompt_chars` (120,000 bytes ≈ 30k input tokens, roughly $0.30–$0.60 at the same frontier rates; keep the pinned "about 3k input and 600 output tokens" sentence verbatim).
- Tests: `INPUT_NAMES` + smoke list gain `max_prompt_chars`; default 120000; `0`/`-5`/`"lots"`/`"12.5"` rejected naming the input, `"1"` accepted; renderer tests (omitted line via 6th param; 20-cap line with 25 skipped); `tests/main.test.ts:173` + `tests/evals/harness.ts:32` gain `maxPromptChars: 60000` (any sane value — these fixtures never assert it); `MockOpts` gains `maxPromptChars?: number` and `inputsFor` uses `o.maxPromptChars ?? 120000` (the per-test override seam Task 58 needs).

- [ ] **Step 1: Write the failing tests**

In `tests/inputs.test.ts` (extend `INPUT_NAMES`, add default + reject/accept cases following the `max_diff_chars` cases at `:215-248`); in `tests/smoke.test.ts` (add the name to the declared-inputs list); in `tests/prompt.test.ts` (new `describe("budget rendering")` with the omitted-line + 20-cap tests).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/inputs.test.ts tests/smoke.test.ts tests/prompt.test.ts`
Expected: FAIL (unknown input, no param, no cap).

- [ ] **Step 3: Implement (`action.yml`, `src/inputs.ts`, `src/prompt.ts`, `README.md`)**

Per Exact behavior. Keep every existing string byte-identical except the listed additions.

- [ ] **Step 4: Run tests + build**

Run: `npx vitest run tests/inputs.test.ts tests/smoke.test.ts tests/prompt.test.ts tests/readme.test.ts && npx vitest run && npm run evals && npx tsc --noEmit -p tsconfig.json && npm run build && node --check dist/index.js`
Expected: PASS all green; build clean. (`npm run evals` proves artifact identity — no product behavior changed yet.)

- [ ] **Step 5: Commit**

```bash
git add action.yml src/inputs.ts src/prompt.ts README.md tests/inputs.test.ts tests/smoke.test.ts tests/prompt.test.ts tests/readme.test.ts tests/main.test.ts tests/evals/harness.ts dist/index.js
git commit -m "feat: max_prompt_chars input and budget-aware rendering (F10)"
```

---

### Task 58: F10 — budget decision + slow-path wiring

**Files:**
- Modify: `src/main.ts` (`budgetPrompt`, single assembly before the branch, `promptFast` copy, skip warning, issue-dropped log line)
- Test: `tests/main.test.ts` (`describe("prompt budget")`)

**Interfaces:**
- Consumes: Task 57's `maxPromptChars`, 6-arg `buildMessages`, exported `neutralise`/constants.
- Produces: `export function budgetPrompt(fast: Finding[], promptText: string, issueBody: string | undefined, skipped: string[], budget: number): { fast: Finding[]; promptText: string; issueBody: string | undefined; skipped: string[]; findingsOmitted: number; issueDropped: boolean }` — all returned strings already neutralised.

**Exact behavior:**
- `promptFast = fast.map(sanitizeFinding)` computed in `slowPath` (after key/model/endpoint/ollama/model-check preconditions); `fast` never mutated.
- Single assembly before `if (i.llmAgent)`: `const b = budgetPrompt(promptFast, promptText, issueBody, skipped, i.maxPromptChars)`; render `buildMessages(b.fast, b.promptText, b.issueBody, b.skipped, i.llmAgent ? { maxTurns: i.llmAgentMaxTurns } : undefined, b.findingsOmitted)`; measure; skip with `` `prompt <bytes> exceeds max_prompt_chars <budget> after bounded cuts` `` when over (no LLM call); log `` `linked issue context dropped to fit the <budget>-byte prompt budget` `` when `issueDropped`.
- Cut loop per spec (neutralise-first with the exported constants; allowance with `framing` minus issue block and byte-exact `issueOverhead` ≈ 145; whole-finding tail drops with re-rendered counts; diff never cut; `Buffer.byteLength` everywhere; UTF-8 back-off on cuts).
- Omitted findings still post (uses full `fast`).

- [ ] **Step 1: Write the failing tests in `tests/main.test.ts`**

`describe("prompt budget")`, driven through `runWithMocks` with `maxPromptChars` overrides (check `MockOpts` for an inputs-override seam, e.g. how `maxDiffChars` is set — mirror it; add `maxPromptChars` to the fixture inputs default at `:173` = 60000 if Task 57 hasn't):

```ts
it("truncates an oversized issue with a balanced marker", ...); // ~5 KB issue, small budget; tags balanced; rest intact
it("drops the issue block when the allowance is negative", ...); // budget 3,200, diff ~2.7 KB, one finding, issue ~5 KB → issueDropped; review proceeds
it("drops whole findings with an exact omitted count", ...); // many findings + small budget; JSON parses; prose line present
it("never cuts the diff, skipping instead", ...); // maxed diff + maxPromptChars 1000 → skip warning with both sizes; llmCalled 0
it("skips after cuts are exhausted", ...); // 5.2 KB-first patch + 25 tiny files, maxDiffChars 5500, maxPromptChars 6000; exact byte sums; llmCalled 0
it("pins the multibyte floor", ...); // 8 × 7,450-unit CJK files; default-scale budget; skip, no LLM call
it("sanitizes evidence before the prompt", ...); // control chars/over-long fields stripped in captured prompt
it("still posts omitted findings", ...); // dropped finding appears in the posted review
it("renders the omission line on the agent path", ...); // llmAgent fixture + small budget → user message contains the prose line
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/main.test.ts`
Expected: FAIL (no `budgetPrompt`, no wiring).

- [ ] **Step 3: Implement in `src/main.ts`**

Per Exact behavior. Touch nothing else in the slow path (ordering, gates, publication identical).

- [ ] **Step 4: Run tests + build**

Run: `npx vitest run tests/main.test.ts tests/prompt.test.ts && npx vitest run && npm run evals && npx tsc --noEmit -p tsconfig.json && npm run build && node --check dist/index.js`
Expected: PASS all green (suite + evals); build clean.

- [ ] **Step 5: Commit**

```bash
git add src/main.ts tests/main.test.ts dist/index.js
git commit -m "fix: enforce whole-request prompt budget with structured cuts (F10)"
```
