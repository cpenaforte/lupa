# Run-visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-run LLM spend is logged, and optional SARIF failures are visible — both without changing gates, findings, or job greenness.

**Architecture:** Task 78 threads optional usage from all four provider adapters through results into a single slowPath aggregate line. Task 79 adds an outcome-guarded warning step to the unprivileged template. Sequential (78 → 79); no shared files.

**Tech Stack:** TypeScript 5.x, Node >=24, vitest, esbuild (`dist/` committed); GitHub Actions YAML + actionlint (via ci.test).

**Specs:** `docs/superpowers/specs/2026-10-13-usage-logging-design.md`, `docs/superpowers/specs/2026-10-13-sarif-failure-design.md`

## Global Constraints

- No new runtime dependencies, no new action inputs (usage task); no code/`dist`/inputs/evals changes (SARIF task).
- `PR_REVIEWER_*` env names, `pr-reviewer-*` strings, `pr-reviewer/1.0` user-agent, SARIF driver name, `lupa:` log prefixes unchanged.
- Each code task ends with `npx tsc --noEmit -p tsconfig.json`, `npm run build && node --check dist/index.js` and commits `dist/index.js`.
- Full suite (`npx vitest run`) + evals (`npm run evals`) green before every task commit (evals after build).
- Commit messages use the exact strings given per task.
- Ships with the next release vehicle — no tag alone.

## Review Focus

- **A provider response without usage leaves results byte-identical.** Test in Task 78's step style (existing suites green with zero pin updates).
- **Five agent turns with mixed usage sum to one total.** Test in Task 78's step style.
- **A skipped SARIF upload stays silent.** Test in Task 79's step style (guard shape pins outcome vocabulary).
- **A failed upload warns but the job stays green.** Test in Task 79's step style (note step only echoes).
- **An eval run emits no usage line.** Test in Task 78's step style (harness fakes carry no usage — asserts eval-summary safety).

---

### Task 78: aggregate usage from adapters to one slowPath line

**Files:**
- Modify: `src/llm.ts` (`LlmUsage{input,output,calls}` + `extractUsage(body, apiStyle: ResolvedApiStyle)` exported + its 2 call-site attaches + `AgentReply.usage?` + `LlmResult` ok:true gains `usage?: LlmUsage` + `withAgentUsage(outcome, result)` propagation in `callByStyleAgent` (`:828`) and all 4 `callWithProbeAgent` returns (`:915,:943,:947,:949`)), `src/adapters/google.ts` + `src/adapters/messages.ts` + `src/adapters/responses.ts` (2 call-site attaches each), `src/agent.ts` (accumulate at each `callWithDeadline` receive point after the raced guard, attach total in `finish()`), `src/main.ts` (`slowPath` sum + `note()`)
- Test: `tests/llm.test.ts` (extraction present/absent/partial/non-object per style family), `tests/adapters-google.test.ts` + `tests/adapters-messages.test.ts` + `tests/adapters-responses.test.ts` (usage fixtures: present exact, absent unchanged), `tests/agent.test.ts` (mixed-turn sum, raced-timeout exclusion), `tests/main.test.ts` (note exact string + silence pin)
- Rebuild: `dist/index.js`

**Interfaces:**
- Consumes: provider response JSON at the 8 existing parse sites; `note()` helper.
- Produces: `usage?: LlmUsage{input,output,calls}` on ok:true results (adapters attach `calls: 1`); `AgentOutcome.usage?` totals; one gated `note()` line. Nothing downstream (terminal behavior).

**Exact behavior:**
- `extractUsage(body, apiStyle): {input,output} | undefined` — per spec §4 mappings (chat prompt/completion; responses input/output; messages input+caches/output with input_tokens required; google prompt/total−prompt-or-candidates); non-object → absent; partial/non-finite/negative → absent; Google cached no-addition.
- Attach `calls: 1` at each call site (extractor returns shape only).
- Agent: accumulate non-raced ok `AgentReply.usage` (with `calls`) at each `callWithDeadline` receive point AFTER the raced guard — never inside `.then` callbacks, so late dangling resolutions cannot add post-`finish()`; `finish()` attaches total iff contributions > 0; `callByStyleAgent` (`llm.ts:828`) and all 4 `callWithProbeAgent` returns (`:915,:943,:947,:949`) copy `outcome.usage` onto ok:true results via one `withAgentUsage(outcome, result)` helper (conditional, no explicit undefined key); ok:false never carries.
- `slowPath`: read `result.usage`; emit `lupa: llm usage input=<n> output=<m> tokens (calls=<k>)` via `note()` after verdict post-processing on success returns; zero contributions → no line.
- Numbers only everywhere. `Analysis` interface, fakes, prompts, budgets, gates untouched.

- [ ] **Step 1: Write the failing tests**
  - Extraction: 4 families × present-exact / absent / partial / non-object; messages cache fold + caches-alone-absent; Google total−prompt + candidates fallback + negative-derived absent; extractor returns `{input,output}`, attach points add `calls: 1`.
  - Agent: five-turn mixed present/absent sum (exact total incl. `calls`); raced timeout excluded incl. a late-resolution-observability case (dangling resolve after `finish` adds nothing); outcome absent when zero.
  - Eval silence: fake-Analysis run (no usage, as the harness provides) emits no `llm usage` line in log or summary (positive silence assertion, not just green evals).
  - slowPath: exact note string; silence (no line) on no-usage/agent-skip/failure.
  - No updates to existing pins (absent-when-missing proves itself) + NEW `not.toHaveProperty("usage")` assertions on absent paths (`toEqual` ignores undefined keys, so green alone proves nothing).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/llm.test.ts tests/adapters-google.test.ts tests/adapters-messages.test.ts tests/adapters-responses.test.ts tests/agent.test.ts tests/main.test.ts`
Expected: FAIL (no usage plumbing).

- [ ] **Step 3: Implement**

Per Exact behavior + Interfaces.

- [ ] **Step 4: Run tests + build**

Run: `npx vitest run tests/llm.test.ts tests/adapters-google.test.ts tests/adapters-messages.test.ts tests/adapters-responses.test.ts tests/agent.test.ts tests/main.test.ts && npx tsc --noEmit -p tsconfig.json && npm run build && node --check dist/index.js && npm run evals && npx vitest run`
Expected: PASS all green (evals after build); build clean.

- [ ] **Step 5: Commit**

```bash
git add src/llm.ts src/agent.ts src/main.ts src/adapters/google.ts src/adapters/messages.ts src/adapters/responses.ts tests/llm.test.ts tests/adapters-google.test.ts tests/adapters-messages.test.ts tests/adapters-responses.test.ts tests/agent.test.ts tests/main.test.ts dist/index.js
git commit -m "feat: log aggregate LLM token usage per run"
```

---

### Task 79: warn on SARIF upload failure (template-only)

**Files:**
- Modify: `docs/workflow-template.yml` (`id: sarif` + note step after upload), `tests/templates.test.ts` (new pins)
- Test: `tests/templates.test.ts`, `tests/ci.test.ts` (actionlint coverage, unchanged)

**Interfaces:**
- Consumes: existing upload step + privileged-notice precedent.
- Produces: visible failure signal (nothing downstream — terminal task).

**Exact behavior:**
- Upload step gains exactly one line (`id: sarif`); guard/continue-on-error/uses/name byte-identical.
- New `Note SARIF upload failure` step immediately after: `if: always() && steps.sarif.outcome == 'failure'`, body echoes the spec §3 `::warning::` sentence then appends the spec §3 summary sentence via heredoc (both verbatim from the spec).
- Pins mirroring `:234-268` shape: id present, guard, warning text, summary text, order (upload → note).
- Privileged template, code, `dist/`, inputs, evals untouched.

- [ ] **Step 1: Write the failing tests**
  - Presence/shape pins per Exact behavior; guard-vocabulary pin (`== 'failure'`, skipped stays silent — cite outcome semantics); note-step echoes-only pin (step has only name/if/run keys, no exit/continue-on-error/false).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/templates.test.ts tests/ci.test.ts`
Expected: FAIL (no id, no note step).

- [ ] **Step 3: Implement**

Per Exact behavior + Interfaces.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/templates.test.ts tests/ci.test.ts && npx vitest run`
Expected: PASS all green. (No build: template-only, `dist/` untouched.)

- [ ] **Step 5: Commit**

```bash
git add docs/workflow-template.yml tests/templates.test.ts
git commit -m "docs: warn visibly on SARIF upload failure"
```
