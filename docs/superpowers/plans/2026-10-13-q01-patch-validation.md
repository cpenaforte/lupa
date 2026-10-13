# Q01 suggestion-patch validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Only model-supplied replacement code renders as an applicable suggestion fence; prose always renders as advice.

**Architecture:** Task 74 adds the nullable `patch` field to the contract, schema, parser, and sanitizers (following the Q04 confidence precedent exactly). Task 75 splits rendering on `hasPatch` plus the existing RIGHT-side target rule, with survivor, fallback, and docs. Sequential (74 → 75). (Last follow-up of the dedup → Q04 → Q02 → Q01 order.)

**Tech Stack:** TypeScript 5.x, Node >=24, vitest, esbuild (`dist/` committed).

**Spec:** `docs/superpowers/specs/2026-10-13-q01-patch-validation-design.md`

## Global Constraints

- No new runtime dependencies, no new action inputs, no template or CI changes.
- `PR_REVIEWER_*` env names, `pr-reviewer-*` strings, `pr-reviewer/1.0` user-agent, SARIF driver name, `lupa:` log prefixes unchanged.
- Every task ends with `npx tsc --noEmit -p tsconfig.json`, `npm run build && node --check dist/index.js` and commits `dist/index.js`.
- Full suite (`npx vitest run`) + evals (`npm run evals`) green before every task commit (evals after build).
- Commit messages use the exact strings given per task.
- Ships with the next release vehicle — no tag alone.

## Review Focus

- **A prose suggestion on a valid RIGHT line no longer fences.** Test in Task 75's step style (suggestion-only RIGHT hit → advice text, no fence).
- **A whitespace-only patch never fences.** Test in Task 74's step style (`hasPatch` unit) and Task 75's step style (no fence rendered).
- **An over-cap patch renders advice, never a truncation-marker fence.** Test in Task 75's step style (4000-space prefix + code through `sanitizeFinding` THEN `formatBody` → advice-only block; raw-to-formatBody would fence and must not be tested that way).
- **A wrong-typed patch keeps its finding with no patch.** Test in Task 74's step style (`patch: [...]` → finding kept, field absent).
- **A backtick-containing patch on LEFT stays inside its advice block.** Test in Task 75's step style (fence sized past the backtick run).

---

### Task 74: Q01 — contract, schema, parser, sanitizers

**Files:**
- Modify: `src/fastpath.ts` (`Finding.patch`), `src/prompt.ts` (schema property + required + `DEDUP_INSTRUCTIONS` sentence next to the confidence sentence), `src/llm.ts` (`toFindings` carries valid string patch, drops wrong-typed field), `src/main.ts` (`isFinding` shape, `sanitizeFinding` strip+cap at `SUGGESTION_CAP`), `src/review.ts` (`redactFindings` redacts patch with same keys)
- Test: `tests/prompt.test.ts` (`:148` required, `:150` sorted keys), `tests/adapters-google.test.ts` (`:48`, `:551` required append-last, EXPECTED properties entry, `:122` body), `tests/probe-routing.test.ts` + `tests/adapters-routing.test.ts` (single-shot pins), `tests/llm.test.ts` (carry/drop matrix), `tests/main.test.ts` (isFinding/sanitize units), `tests/review.test.ts` (`hasPatch` units + redact-patch unit)
- Rebuild: `dist/index.js`

**Interfaces:**
- Consumes: existing `toFindings`/`sanitizeFinding`/`redactFindings` patterns (confidence field-drop is the template).
- Produces: `Finding.patch?: string`; `hasPatch(f)` (trimmed-nonempty on the sanitized value, TRUNC_MARK-terminated fails); schema + required + converted expectation carrying `patch`; instruction sentence verbatim from spec §4 (escaped backticks, single-shot path only — agent SYSTEM byte-identical).

**Exact behavior:**
- Contract: patch absent or string (else `isFinding` violation as today).
- `toFindings`: string carried; `null`/absent → absent; wrong type → field dropped, finding kept (positions untouched — verdict-index alignment holds).
- Sanitize: `CONTROL_KEEP_TEXT` strip, then `capText` at `SUGGESTION_CAP` (4000); trim-test runs on the capped value.
- Redact: patch redacted with the same secret keys (fresh objects as per Q04 copy-on-write).
- Schema: `patch: {type: ["string","null"]}` scalar (NO `prefixItems`), appended to item `required` (after `confidence`); google conversion automatic.
- Instruction: spec §4 sentence verbatim, appended next to the confidence sentence in `DEDUP_INSTRUCTIONS` (same `withIds && agent === undefined` gate — never the shared `SYSTEM` const).

- [ ] **Step 1: Write the failing tests**
  - `hasPatch` units: present/absent/empty/whitespace-only/TRUNC_MARK-terminated.
  - `toFindings`: carried / `null`→absent / absent→absent / `[...]`
    → field dropped, finding kept / finding with suggestion-only unchanged.
  - `isFinding`: string ok, wrong-type violation. Sanitize: caps + control-strip at 4000. Redact: secret in patch redacted, fresh objects.
  - Instruction tests: `DEDUP_INSTRUCTIONS` contains the spec §4 sentence verbatim; agent `SYSTEM` lacks it (extend the `:250-262` gate-test style: agent system without `DEDUP_INSTRUCTIONS`).
  - Update pins: prompt `:148` + `:150`, google `:48` + `:551` + properties + `:122`. Verify unchanged (no edits): `adapters-routing.test.ts:155` compares dynamically to `PR_REVIEW_SCHEMA` (self-updating); `probe-routing` carries finding inputs only, no schema pins.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/prompt.test.ts tests/adapters-google.test.ts tests/adapters-routing.test.ts tests/probe-routing.test.ts tests/llm.test.ts tests/main.test.ts tests/review.test.ts`
Expected: FAIL (no patch field).

- [ ] **Step 3: Implement**

Per Exact behavior + Interfaces. `formatBody`/`survivor`/fallback untouched (Task 75). Agent prompts byte-identical.

- [ ] **Step 4: Run tests + build**

Run: `npx vitest run tests/prompt.test.ts tests/adapters-google.test.ts tests/adapters-routing.test.ts tests/probe-routing.test.ts tests/llm.test.ts tests/main.test.ts tests/review.test.ts && npx tsc --noEmit -p tsconfig.json && npm run build && node --check dist/index.js && npm run evals && npx vitest run`
Expected: PASS all green (evals after build); build clean.

- [ ] **Step 5: Commit**

```bash
git add src/fastpath.ts src/prompt.ts src/llm.ts src/main.ts src/review.ts tests/prompt.test.ts tests/adapters-google.test.ts tests/probe-routing.test.ts tests/adapters-routing.test.ts tests/llm.test.ts tests/main.test.ts tests/review.test.ts dist/index.js
git commit -m "feat: nullable patch field with confidence-style field-drop"
```

---

### Task 75: Q01 — rendering split, survivor, fallback, docs

**Files:**
- Modify: `src/review.ts` (`formatBody` fence-iff-`hasPatch`+RIGHT, `Suggested:` for suggestion everywhere, LEFT advice-only blocks via `fenceFor(patch)`, `buildBody` general-item advice-only blocks (general items render in `buildBody`, never `formatBody`), fallback `- Proposed patch (advice only):` row LAST, `survivor` first-`hasPatch`, stale doc comments on `fenceFor`/`formatBody`/`buildBody` updated to the patch-gated wording), `README.md` (spec §5 note verbatim)
- Test: `tests/review.test.ts` (rendering matrix, migrated fence tests, fallback order, survivor), `tests/readme.test.ts` (pin phrase `renders in an applicable suggestion fence`)
- Rebuild: `dist/index.js`

**Interfaces:**
- Consumes: Task 74's `patch` field, `hasPatch`, schema/instruction (no prompt/llm changes here).
- Produces: rendered split on every surface (nothing downstream — terminal task).

**Exact behavior:**
- RIGHT + `hasPatch` → `` `suggestion fence with patch verbatim, then `Suggested:` advice when suggestion exists, then trailer. RIGHT + suggestion-only → advice, NO fence (the audit regression pin).
- `hasPatch` gates every patch rendering site (fence, advice blocks, fallback row); failing patches render nothing anywhere (suggestion paths normal). LEFT/general + `hasPatch` → `Suggested replacement (advice only):` label + plain fenced block sized by `fenceFor(patch)` (never ` ```suggestion `), then `Suggested:` text; separators per spec §4 (`\n\n` before label, `\n` label-to-fence, verbatim block, `\n\n` before `Suggested:`); `buildBody` items indent every continuation line with `\n  ` (label, fence, and content lines alike).
- Fallback: `- Proposed patch (advice only):` via `field()` LAST (order message < source < confidence < evidence < remediation < patch); remediation placeholder contract unchanged.
- `survivor`: first member satisfying `hasPatch`, absent iff none.
- Migrate (never delete) existing RIGHT-fence tests to `patch` (`:122-127`, `:151-158`, `:877-883`); audit-shape pins as new tests (prose → advice; genuine replacement → fence).
- README note verbatim from spec §5. Gates, SARIF `message.text`, `findings.json` shape, F15, `summaryFor` untouched. `tests/fixtures/evals/cases.ts` needs NO changes (verified: zero suggestion literals — evals stay green by construction).

- [ ] **Step 1: Write the failing tests**
  - Invalid-patch rendering: whitespace-only / TRUNC_MARK-capped / absent patch on LEFT, general, and fallback inputs renders no label, block, or row (suggestion text or placeholder normal).
  - Matrix: RIGHT+patch fence (verbatim content + order head/fence/Suggested/trailer); RIGHT+suggestion-only advice; empty/whitespace/TRUNC_MARK patch advice; LEFT+patch label + sized block + Suggested; backtick patch stays fenced-in; general-body shapes; fallback row LAST + order assertion; trailer fence-external.
  - Migrate the three fence tests to `patch`; add audit-shape tests (credential-rotation prose, SQL prose → advice; genuine replacement → fence).
  - Survivor first-`hasPatch` + absent-iff-none. README phrase pin.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/review.test.ts tests/readme.test.ts`
Expected: FAIL (suggestion still fences).

- [ ] **Step 3: Implement**

Per Exact behavior + Interfaces. `suggestion` never fences on any path.

- [ ] **Step 4: Run tests + build**

Run: `npx vitest run tests/review.test.ts tests/readme.test.ts && npx tsc --noEmit -p tsconfig.json && npm run build && node --check dist/index.js && npm run evals && npx vitest run`
Expected: PASS all green (evals after build); build clean.

- [ ] **Step 5: Commit**

```bash
git add src/review.ts README.md tests/review.test.ts tests/readme.test.ts dist/index.js
git commit -m "feat: fence only model-supplied patches, prose renders as advice"
```
