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
- **An App-creation failure still posts via the workflow-run token with the downgrade notice.** Pinned by Task 65's template text/placement test (ordering + App-slice); runtime behavior proved by owner canary step 4.
- **Divergent fail_level values fail the suite.** Test in Task 65's step style (parity extraction).
- **An artifact carrying a fail_level-shaped field changes nothing.** Test in Task 66's step style (Flow B fixture with planted field, event from inputs).
- **`github-token` on a fork still skips with the loud warning (producer behavior unchanged).** Test in Task 66's step style (canWrite matrix).

---

### Task 65: F14 — privileged template chain and parity pins

**Files:**
- Modify: `docs/workflow-template-privileged.yml` (App continue-on-error, guard step, token-type arm, fail_level), `README.md` (fork section per spec), `tests/templates.test.ts` (pins + parity), `tests/readme.test.ts` (fork-chain sentences)
- Rebuild: `dist/index.js` (no src changes in this task — the rebuild still runs as a hygiene gate and the commit includes it per Global Constraints; expect an empty diff)

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

- [ ] **Step 1: Write the failing tests in `tests/templates.test.ts` + `tests/readme.test.ts`**

Guard step present with exact name; `if:` contains `always()` and the outcome check; the summary emission is a heredoc (`cat >> "$GITHUB_STEP_SUMMARY" <<'EOF'` with the bare downgrade sentence on its own line, closed by `EOF`) and the annotation is `echo "::notice::<sentence>"` — pinned in exactly that shape. Assertion forms: the annotation is checked as `'::notice::' + sentence`; the heredoc block is checked for the bare sentence on its own line (`toMatch(/^<sentence>$/m)`), so a one-line `echo … >>` form or a prefixed summary line fails. Ordering — guard index after the `Create GitHub App token` step and before `Download` (index comparison on step names); the App step's own block (text between its `name:` line and the next `- name:`) contains `continue-on-error: true` (a file-wide search would also match the Post step); fallback arm contains `'workflow-run'`; parity extraction equality (`fail_level: (\w+)` from the `with:` block after each `uses: cpenaforte/lupa@` line — assert EACH extraction is present and in `none|warning|high` BEFORE asserting equality, so a broken regex can't pass vacuously — privileged equals producer). `tests/readme.test.ts` fork-chain case asserts all four exact sentences (workflow-run default credential; App via `PR_REVIEWER_APP_ID`/`PR_REVIEWER_APP_KEY` recommended; downgrade notice emitted; github-token/unset skip loudly) and keeps the existing "two-workflow pattern" phrase.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/templates.test.ts tests/readme.test.ts`
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
- Modify: `src/main.ts` (`RunEnv.tokenType`, parse, `canWrite`, L2 skip, `:774` unchanged shape; `main.ts:58` doc comment for the replaced field), `tests/main.test.ts` (6 fakes + MockOpts), `tests/evals/types.ts` (`Pick`), `tests/evals/harness.ts` (RunEnv literal `:208`, NOT `defaultInputs` — tokenType is RunEnv, not inputs), `tests/fixtures/evals/cases.ts` (read-only fork case), `README.md:27` if it names the token field
- Test: `tests/main.test.ts` (matrix), Flow B artifact-field test
- Rebuild: `dist/index.js`

**Interfaces:**
- Consumes: Task 65's token-type vocabulary (`app` / `workflow-run` / `github-token`).
- Produces: `RunEnv.tokenType: 'app' | 'workflow-run' | 'github-token'` (replaces `tokenIsApp`; no other consumer).

**Exact behavior:**
- Parse at env construction, pinned as `const value = process.env.PR_REVIEWER_TOKEN_TYPE; tokenType = value === 'app' ? 'app' : value === 'workflow-run' ? 'workflow-run' : 'github-token'` (unset/unknown → `'github-token'`, fail-closed).
- `canWrite = !isFork || tokenType === 'app' || tokenType === 'workflow-run'` (exact). L2 skip (`forkWithSecrets`) uses `tokenType === 'app'` (semantics preserved).
- Fakes: `MockOpts.tokenType?: 'app' | 'workflow-run' | 'github-token'`; env builders use `o.tokenType ?? 'github-token'`; literal `RunEnv` fakes at `tests/main.test.ts:470` (`'github-token'`), `:600` (`'app'`), `:1315` (`'github-token'`); every other `tokenIsApp` occurrence including `runWithMocks` call sites (tsc gate catches stragglers — fix on sight, do not pass `tokenIsApp` through); evals `Pick` + RunEnv literal (`'github-token'`); read-only fork case keeps skip+warn with no post.
- `eventFor` (`src/main.ts:777`) / `exitFor` (Flow A + B exit sites) call sites unchanged; no artifact field is consulted.

- [ ] **Step 1: Write the failing tests in `tests/main.test.ts`**

canWrite matrix — fork rows (app→posts, workflow-run→posts, github-token→skip+loud) plus non-fork rows (all three types post); UNSET and unknown-value rows call `readRunEnv()` directly with the save/assign/restore pattern (`delete process.env.PR_REVIEWER_TOKEN_TYPE` for UNSET) and assert `readRunEnv().tokenType === 'github-token'` (parse unit — behavior coverage comes from the explicit-type matrix rows); producer github-token fork skip preserved; Flow B fixtures with planted `fail_level`-shaped fields as PER-ELEMENT properties of the findings array (a top-level key throws contract-mismatch for the wrong reason) in BOTH pr-meta.json and findings.json where the input `fail_level` DIFFERS from the planted value → assert `event` and `exitCode` follow the inputs. (Placement: per-element properties of the findings array — a top-level key throws contract-mismatch for the wrong reason; `pr-meta.json` has no findings array so a top-level key there is correct.)

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

1. Point test-lupa's privileged template at the Task 66 commit SHA (NOT `658ab55`, which predates the feature — the Task 65 commit alone lacks the in-action gate).
2. Fork PR with a warning-severity finding, NO App configured → expect posted COMMENT review + downgrade line in the post run's summary/annotations.
3. Same with App configured → expect the notice gone, review posted.
4. Same with an INVALID App key → expect a posted COMMENT review plus the downgrade notice (resilient fallback, not a red job with no review).
5. Record verdicts (links) in the task report thread or PR comments.
