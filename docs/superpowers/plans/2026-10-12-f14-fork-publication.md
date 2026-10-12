# F14 fork publication policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fork PRs get a posted review under one explicit trusted policy, with matching severity and no silent skips.

**Architecture:** Task 65 rewires the privileged template (credential chain, guard notice, explicit fail_level) with template-test pins; Task 66 replaces `tokenIsApp` with the fail-closed `tokenType` union and wires the allowlist gate. Sequential (65 → 66). (Roadmap Task 51 is the F14 *stage*; implementation Tasks 65–66 below are its execution units. The consumer canary is owner-run after merge.)

**Tech Stack:** TypeScript 5.x, Node >=24, vitest, esbuild (`dist/` committed), actionlint on the edited template.

**Spec:** `docs/superpowers/specs/2026-10-12-f14-fork-publication-design.md`

## Global Constraints

- No new runtime dependencies, no new action inputs, no CI changes. (`docs/workflow-template-privileged.yml` + README in scope; other templates untouched.)
- `PR_REVIEWER_*` env names, `pr-reviewer-*` strings, `pr-reviewer/1.0` user-agent, SARIF driver name, `lupa:` log prefixes unchanged.
- Every task ends with `npx tsc --noEmit -p tsconfig.json`, `npm run build && node --check dist/index.js` and commits `dist/index.js`. Task 65 also runs `actionlint` on the edited template (if actionlint is unavailable, state so in the report and note it as a merge-check item).
- Full suite (`npx vitest run`) + evals (`npm run evals`) green before every task commit (evals after build).
- Commit messages use the exact strings given per task.
- Ships with the whole-plan release — no tag for F14 alone. Template SHA stays `658ab55` (re-pin happens at release, not here).

## Review Focus

- **An unset token type on a fork never posts.** Test in Task 66's step style (fail-closed matrix row).
- **An App-creation failure still posts via the workflow-run token with the downgrade notice.** Pinned by Task 65's template text/placement test; behavior proved by the owner canary.
- **Divergent fail_level values fail the suite.** Test in Task 65's step style (parity extraction).
- **An artifact carrying a fail_level-shaped field changes nothing.** Test in Task 66's step style (Flow B fixture with planted field, event from inputs).
- **`github-token` on a fork still skips with the loud warning (producer behavior unchanged).** Test in Task 66's step style (canWrite matrix).

---

### Task 65: F14 — privileged template chain and parity pins

**Files:**
- Modify: `docs/workflow-template-privileged.yml` (App continue-on-error, guard step, token-type arm, fail_level), `README.md` (fork section per spec), `tests/templates.test.ts` (pins + parity), `tests/readme.test.ts` (fork-chain sentences)
- Rebuild: `dist/index.js` (no src changes — rebuild still runs as a hygiene gate; commit only if changed)

**Interfaces:**
- Consumes: spec §2 exact strings (notice text, `fail_level: warning`, token-type values).
- Produces: template token-type vocabulary `app` / `workflow-run` (fallback arm), guard step contract, parity extraction pattern (used by Task 66 only as documentation — no code dependency).

**Exact behavior:**
- App step gains `continue-on-error: true` (unchanged `if:` on the vars check).
- Guard step immediately after the App step: name `Note posting credential`, `if: always() && steps.app.outcome != 'success'`, body appends the spec's exact notice line to `$GITHUB_STEP_SUMMARY` AND echoes the identical `::notice::` line (both, verbatim).
- Token-type line fallback arm `'github-token'` → `'workflow-run'` (the `steps.app.outcome == 'success' && 'app' ||` prefix unchanged).
- Post step `with:` gains `fail_level: warning` (after the existing keys; producer template already has it — untouched).
- `templates.test.ts`: guard step present (name + `always()` + outcome check + both notice emissions with the exact downgrade sentence); App step has `continue-on-error: true`; fallback arm contains `'workflow-run'`; parity case — extract `fail_level: (\w+)` from the `with:` block following the `uses: cpenaforte/lupa@` line in EACH template, `expect(privileged).toBe(producer)`.
- README fork section rewritten to the spec's required content (workflow-run default credential; App via `PR_REVIEWER_APP_ID`/`PR_REVIEWER_APP_KEY` recommended; github-token/unset skip loudly).

- [ ] **Step 1: Write the failing tests in `tests/templates.test.ts`**

Guard/name/`always()`/both emissions/exact sentence; App `continue-on-error`; `'workflow-run'` arm; parity extraction equality. README assertions (workflow-run default, App vars, loud skip) go in `tests/readme.test.ts` as a new fork-chain case. `tests/readme.test.ts` joins the Step 5 commit.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/templates.test.ts`
Expected: FAIL (no guard, no arm, no parity).

- [ ] **Step 3: Implement in `docs/workflow-template-privileged.yml` + `README.md`**

Per Exact behavior. Touch nothing else.

- [ ] **Step 4: Run tests + build + actionlint**

Run: `npx vitest run tests/templates.test.ts && npx tsc --noEmit -p tsconfig.json && npm run build && node --check dist/index.js && npm run evals && npx vitest run && actionlint docs/workflow-template-privileged.yml`
Expected: PASS all green; template lint clean. (If actionlint is missing: report it, keep going, flag as merge-check.)

- [ ] **Step 5: Commit**

```bash
git add docs/workflow-template-privileged.yml README.md tests/templates.test.ts tests/readme.test.ts dist/index.js
git commit -m "feat: fork posting via workflow-run token with visible downgrade (F14)"
```

---

### Task 66: F14 — fail-closed token type in action code

**Files:**
- Modify: `src/main.ts` (`RunEnv.tokenType`, parse, `canWrite`, L2 check, `:774` unchanged shape), `tests/main.test.ts` (6 fakes + MockOpts), `tests/evals/types.ts` (`Pick`), `tests/evals/harness.ts` (`defaultInputs`), `tests/fixtures/evals/cases.ts` (read-only fork case)
- Test: `tests/main.test.ts` (matrix), Flow B artifact-field test
- Rebuild: `dist/index.js`

**Interfaces:**
- Consumes: Task 65's token-type vocabulary (`app` / `workflow-run` / `github-token`).
- Produces: `RunEnv.tokenType: 'app' | 'workflow-run' | 'github-token'` (replaces `tokenIsApp`; no other consumer).

**Exact behavior:**
- Parse at env construction: `PR_REVIEWER_TOKEN_TYPE === 'app' ? 'app' : value === 'workflow-run' ? 'workflow-run' : 'github-token'` (unset/unknown → `'github-token'`, fail-closed).
- `canWrite = !isFork || tokenType === 'app' || tokenType === 'workflow-run'` (exact). L2 scrub uses `tokenType === 'app'` (semantics preserved).
- Fakes: `MockOpts.tokenType?: 'app' | 'workflow-run' | 'github-token'`; env builders use `o.tokenType ?? 'github-token'`; evals `Pick` + `defaultInputs` (`'github-token'`); read-only fork case keeps skip+warn with no post.
- `eventFor`/`exitFor` call sites unchanged; no artifact field is consulted.

- [ ] **Step 1: Write the failing tests in `tests/main.test.ts`**

canWrite matrix on forks (app→posts, workflow-run→posts, github-token→skip+loud, UNSET→skip+loud — construct env without the var); producer github-token fork skip preserved; Flow B fixture with a planted `fail_level`-shaped field in pr-meta → event still from inputs.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/main.test.ts`
Expected: FAIL (no tokenType).

- [ ] **Step 3: Implement in `src/main.ts` + fakes/harness/cases**

Per Exact behavior + Interfaces. `eventFor`/`exitFor` untouched. Touch nothing else.

- [ ] **Step 4: Run tests + build**

Run: `npx vitest run tests/main.test.ts tests/evals && npx tsc --noEmit -p tsconfig.json && npm run build && node --check dist/index.js && npm run evals && npx vitest run`
Expected: PASS all green (evals after build); build clean.

- [ ] **Step 5: Commit**

```bash
git add src/main.ts tests/main.test.ts tests/evals/types.ts tests/evals/harness.ts tests/fixtures/evals/cases.ts dist/index.js
git commit -m "fix: fail-closed fork token type with workflow-run posting (F14)"
```

---

## Owner canary (manual, after merge — required by spec §3)

Not implementer work (needs a live fork + App toggle); the implementer records it as pending in the Task 66 report.

1. Point test-lupa's privileged template at the F14 commit SHA (NOT `658ab55`, which predates the feature).
2. Fork PR with a warning-severity finding, NO App configured → expect posted COMMENT review + downgrade line in the post run's summary/annotations.
3. Same with App configured → expect the notice gone, review posted.
4. Record verdicts (links) in the task report thread or PR comments.
