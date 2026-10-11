# Deterministic Quality and Integration Evaluation Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task. Use one fresh `gpt-6-luna` implementer per task and one fresh `gpt-6.1-sol` task reviewer after each task, as selected by the user. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic synthetic PR evaluation corpus that exercises Lupa's committed bundle and agent tool loop locally and in CI, with assertion-based regression results and no provider or network dependency.

**Architecture:** Invoke the committed `dist/index.js` export `run(env, deps)` with an in-memory fake `Gateway` and fake `Analysis`, while a separate test drives production `runAgent` using scripted hooks and a temporary repository. Keep synthetic case fixtures versioned, expose a dedicated Vitest npm script, and run the same script after the CI bundle build.

**Tech Stack:** Node.js 24, TypeScript 5.9, Vitest 5, esbuild bundle, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-11-quality-integration-evaluation-design.md`

## Global Constraints

- Eval tests must use no secrets, make no network requests, invoke no external scanner, and make no live provider calls.
- Exercise orchestration from the committed `dist/index.js` and agent behavior through production `runAgent` with scripted hooks.
- Keep every PR, repository snapshot, finding, and fake model response clearly labeled synthetic.
- Report named case outcomes; do not claim general model-review quality or compute an aggregate quality score.
- Do not change review behavior, policy, provider/GitHub adapters, scanner coverage, consumer templates, or canary workflows.
- Keep F09, F10, F11, F13, F15, and Q01–Q04 behavior outside this plan; large-diff assertions cover diff truncation only, not whole-request budgeting.
- Keep live provider and `test-lupa` consumer canaries separate from the deterministic CI gate.

## Review Focus

- **Bundle entry guard:** importing the committed bundle from Vitest or a helper process must not run `main()` or write GitHub outputs; pin this in Task 1.
- **Temporary fixture lifecycle:** repeated case runs and thrown assertions must not leak scratch directories or files; use scoped cleanup in Task 1.
- **Manifest integrity:** duplicate IDs and missing approved categories must fail with an actionable list instead of silently shrinking the corpus; pin this in Task 2.
- **Diff-side correctness:** deleted-line findings use the actual LEFT-side old-line mapping, while unchanged baseline paths remain off-diff; pin both in Task 2.
- **Large-diff visibility:** independently exercise the per-file cap and global diff allowance, including truncation and omitted-file notes without asserting a full-request budget; pin in Task 2.

---

### Task 1: Bundle evaluation runner and baseline cases

**Files:**
- Create: `tests/evals/types.ts`
- Create: `tests/evals/corpus.ts`
- Create: `tests/evals/harness.ts`
- Create: `tests/evals/bundle.test.ts`
- Create: `tests/evals/import-bundle-probe.mjs`
- Create: `tests/fixtures/evals/README.md`
- Create: `tests/fixtures/evals/cases.ts`
- Create: `tests/fixtures/evals/positive-authz.patch`
- Create: `tests/fixtures/evals/positive-command.patch`
- Create: `tests/fixtures/evals/safe-negative.patch`
- Create: `tests/fixtures/evals/repaired-authz.patch`
- Modify: `package.json`

**Interfaces:**
- `EvalCase` in `tests/evals/types.ts` carries `id`, `categories`, `syntheticRationale`, `patchFixture`, optional `repoFiles`, `inputOverrides?: Partial<ActionInputs>`, separate `envOverrides?: Partial<Pick<RunEnv, "tokenIsApp" | "issueFallback">>`, fake gateway mode, scripted scanner/L2/LLM findings, and an `expected` record for prompt diff snippets, structured findings, exit code, summary, and publication path/payload (review event/comments/body or issue-comment body, including an explicit no-write expectation).
- `tests/fixtures/evals/cases.ts` is the typed, versioned manifest of case metadata, scripted responses, and expectations; `tests/evals/corpus.ts` imports and re-exports it. Keep fixture metadata and associated patches/repository snapshots together under `tests/fixtures/evals/`.
- `runBundleEval(testCase: EvalCase): Promise<EvalRun>` in `tests/evals/harness.ts` loads the built bundle's `run`, creates a synthetic `RunEnv`, writes `diff.patch` to `artifactDir` and repository snapshot files to the distinct `workDir` under one temporary scratch root, supplies fake dependencies, and returns the `Outcome`, captured prompts/publications, and artifact paths.
- `EvalRun` records the `Outcome`, captured LLM messages, fake gateway calls and payloads, final `findings.json`, and Step Summary content.
- Fake `Gateway` implements every `Gateway` method; fake `Analysis` implements every `Analysis` method. Scanner/L2 methods return fixture data; provider and model methods are deterministic stubs; no method reaches production adapters.
- Load `dist/index.js` with a dynamic import URL and cast its `run` export to the source `run` type. This avoids a static TypeScript module-resolution dependency on the generated bundle.
- `package.json` adds `"evals": "vitest run tests/evals --reporter=verbose"`; local execution first runs `npm run build`.

- [ ] **Step 1: Write the first failing bundle-eval tests**

Create `tests/evals/bundle.test.ts` with one separately named `it.each` test per manifest record, initially covering two positive findings, a safe-negative control, and a repaired control. Each test calls a shared `assertCommonCaseContract(testCase, result)` helper that checks the case's expected prompt diff snippet, exact structured findings, exit status, summary result, and exact publication path/payload (review event/comments/body or issue-comment body, or explicitly no write); positive records also assert the changed-line inline comment. Every record must provide its expected prompt diff snippet. Import the not-yet-created case registry and `runBundleEval`.

- [ ] **Step 2: Run the test to confirm the harness is missing**

Run: `npx vitest run tests/evals/bundle.test.ts`

Expected: FAIL because `tests/evals/corpus.ts` and `tests/evals/harness.ts` do not exist yet.

- [ ] **Step 3: Implement the typed corpus and bundle harness**

Create `EvalCase` / `EvalRun`, the typed manifest in `tests/fixtures/evals/cases.ts`, and the four initial patch fixtures. In `runBundleEval`, use a valid synthetic `pull_request` event, fixed valid base/head SHAs, a fake PR record, and a non-secret fixture key consumed only by the fake analysis boundary. Write `diff.patch` to `artifactDir`, repository snapshot files to the distinct `workDir`, and the Step Summary inside one temporary scratch root; remove the root with Vitest cleanup even when assertions fail. Record `callWithProbe` / `callByStyle` inputs and return the fixture LLM findings. Stub `fetch` to throw and assert it was not called. Return empty/default scanner and L2 results from the fake methods unless a case supplies findings.

Create `tests/evals/import-bundle-probe.mjs` to dynamically import the absolute `dist/index.js` URL. Add a test that runs this helper with `GITHUB_EVENT_NAME=push`, a valid push event path, and `GITHUB_OUTPUT` pointed at a fresh temporary path; verify the import exits successfully without creating the output file, proving the bundle entry guard did not call `main()`.

In `tests/fixtures/evals/README.md`, state that all cases and responses are synthetic regression fixtures, not model-quality evidence.

- [ ] **Step 4: Add and run the local eval script**

Add `"evals": "vitest run tests/evals --reporter=verbose"` to `package.json`.

Run: `npm run build && npm run evals`

Expected: build succeeds and every baseline bundle case passes with its own Vitest test name.

- [ ] **Step 5: Commit Task 1**

```bash
git add package.json tests/evals tests/fixtures/evals
git commit -m "test: add deterministic bundle evaluation harness"
```

---

### Task 2: Complete the required PR scenario corpus

**Files:**
- Modify: `tests/evals/types.ts`
- Modify: `tests/evals/corpus.ts`
- Modify: `tests/evals/bundle.test.ts`
- Modify: `tests/evals/harness.ts`
- Modify: `tests/fixtures/evals/cases.ts`
- Create: `tests/fixtures/evals/deletion.patch`
- Create: `tests/fixtures/evals/force-push.patch`
- Create: `tests/fixtures/evals/fork-readonly.patch`
- Create: `tests/fixtures/evals/large-per-file.patch`
- Create: `tests/fixtures/evals/large-total.patch`
- Create: `tests/fixtures/evals/unchanged-baseline.patch`
- Create: `tests/fixtures/evals/unchanged-baseline/src/legacy-vulnerability.ts`

**Interfaces:**
- Extend `EvalCategory` with `"deletion"`, `"force-push"`, `"fork-readonly"`, `"large-diff"`, and `"unchanged-baseline"`.
- Extend the fake gateway mode with `headMovesBeforePost` and `isFork`. Use separate case fields `inputOverrides?: Partial<ActionInputs>` and `envOverrides?: Partial<Pick<RunEnv, "tokenIsApp" | "issueFallback">>`; `maxDiffChars` belongs in input overrides, while fork token and fallback settings belong in run-environment overrides.
- Keep assertions against the existing `Outcome`, `ReviewPayload`, `Finding`, and summary behavior; do not add production interfaces.

- [ ] **Step 1: Add failing category and scenario assertions**

Add a manifest test requiring these categories: `positive`, `safe-negative`, `repaired`, `deletion`, `force-push`, `fork-readonly`, `large-diff`, and `unchanged-baseline`. Make it fail on duplicate case IDs and report every missing category in its assertion message. Add six new scenario records covering the five new groups (deletion, force-push, fork-readonly, per-file large-diff, global large-diff, and unchanged-baseline) to the typed fixture manifest, each with a synthetic rationale, prompt diff snippet, scripted response, and expected findings/status/summary/publication. Keep one separately named `it.each` test for every manifest record and call `assertCommonCaseContract` for every record, so prompt input, structured findings, exit status, summary, and exact publication path/payload are checked across the entire corpus; add scenario-specific assertions for the six new records.

- [ ] **Step 2: Run the focused suite to confirm missing coverage**

Run: `npx vitest run tests/evals/bundle.test.ts`

Expected: the manifest-completeness assertion passes because all approved categories are present; scenario tests fail because the new patch/repository fixtures and case-specific harness support are not implemented yet.

- [ ] **Step 3: Add deletion, force-push, and fork fixtures**

Add a deletion finding at a deleted old-file line whose numeric line is absent from every RIGHT-side mapping in that file, then assert the exact inline comment path, line, `LEFT` side, and body. Add a force-push case in which the fake live PR head changes after analysis and before review POST; with a warning finding and `failLevel: "warning"`, assert two PR reads, zero review attempts, `posted === false`, `staleSkipped === undefined`, and exit code `2`. This exercises the pre-POST guard without depending on exception-class identity across the separately bundled code and test modules; existing source-level tests continue to cover a stale exception during POST. Add a read-only fork case with `envOverrides.tokenIsApp: false` and `envOverrides.issueFallback: true`; assert summary output, `posted === false`, and zero review or issue-comment writes.

- [ ] **Step 4: Add large-diff and unchanged-baseline fixtures**

For the per-file case, set `inputOverrides.maxDiffChars` above `PER_FILE_CAP`, include one patch section exceeding 8,000 characters, and assert that section's included excerpt is at most 8,000 characters and contains the current truncation marker. For the global case, set `inputOverrides.maxDiffChars` below the concatenated file sections, with at least one section fitting and at least one omitted; assert the included and omitted paths, that the captured excerpt is non-empty and within the configured allowance, and that the omitted path is named in the existing budget note. Do not assert a bound on the entire `messages.user` prompt.

Add a repository snapshot containing a vulnerable-looking function in an unchanged path and a patch touching a separate safe file. The common per-case test must assert the expected changed-file prompt snippet; the scenario assertion must confirm the unchanged path is absent from the captured diff excerpt and no inline comment points to it. Do not assert baseline suppression or blocking policy.

- [ ] **Step 5: Run all bundle corpus evaluations**

Run: `npm run build && npm run evals`

Expected: all required category and per-case assertions pass; no network, real scanner, or provider call occurs.

- [ ] **Step 6: Commit Task 2**

```bash
git add tests/evals tests/fixtures/evals
git commit -m "test: cover synthetic PR evaluation scenarios"
```

---

### Task 3: Add the deterministic agent tool-round evaluation

**Files:**
- Create: `tests/evals/agent.test.ts`
- Create: `tests/fixtures/evals/agent/changed.ts`

**Interfaces:**
- Use the production `runAgent(conv, toolCtx, budget, hooks)` from `src/agent.ts`.
- Use `AgentHooks.call` to return one `read_file` tool call followed by a final JSON finding; no provider adapter or network request is involved.
- Use a temporary `ToolContext` root containing `changed.ts`; assert the final `LlmResult` and `AgentOutcome` directly.

- [ ] **Step 1: Write the failing agent-eval test**

Create `tests/evals/agent.test.ts` with a named test that expects the first assistant turn to request `read_file`, the tool turn to contain the synthetic changed-line evidence, and the final assistant response to parse as one expected finding with the exact file and line. Assert `stop === "final"`, `turns === 2`, `calls === 1`, and that the final hook conversation contains the tool result.

- [ ] **Step 2: Run the focused test to confirm the fixture is absent**

Run: `npx vitest run tests/evals/agent.test.ts`

Expected: FAIL because the fixture/test setup has not been added.

- [ ] **Step 3: Add the agent fixture and scripted tool-round hooks**

Create `changed.ts` with a clearly marked synthetic changed line. Build `ToolContext.roots.self` from a temporary directory, use scripted `AgentReply` values, and clean the temporary directory in `afterEach`. Keep the `fetch` sentinel active and assert zero calls.

- [ ] **Step 4: Run the focused agent evaluation**

Run: `npx vitest run tests/evals/agent.test.ts`

Expected: the real tool loop reads the fixture and returns the scripted structured finding with the asserted accounting.

- [ ] **Step 5: Commit Task 3**

```bash
git add tests/evals/agent.test.ts tests/fixtures/evals/agent/changed.ts
git commit -m "test: evaluate deterministic agent tool rounds"
```

---

### Task 4: Document local use and gate the corpus in CI

**Files:**
- Create: `docs/evaluation-harness.md`
- Modify: `tests/fixtures/evals/README.md`
- Modify: `.github/workflows/ci.yml`
- Modify: `tests/ci.test.ts`

**Interfaces:**
- Local command sequence: `npm ci`, `npm run build`, `npm run evals`.
- CI adds one `npm run evals` step in the existing `build` job after `npm run build` and before bundle syntax/committed-bundle checks.
- Do not add a new job, secret, third-party action, provider service, or consumer canary.

- [ ] **Step 1: Write the failing CI contract test**

Extend `tests/ci.test.ts` to parse `package.json` and the existing `build` job. Assert the `evals` script is `vitest run tests/evals --reporter=verbose`, and `npm run evals` occurs after the `Build bundle` step and before `Syntax-check the bundle`. Assert the eval step defines no secret or provider environment.

- [ ] **Step 2: Run the CI contract test to verify it fails**

Run: `npx vitest run tests/ci.test.ts`

Expected: FAIL because the workflow has no eval step.

- [ ] **Step 3: Add the CI step and local/evidence documentation**

Add a named deterministic evaluation step to the current build job immediately after bundle build. Document the three local commands in `docs/evaluation-harness.md`, explain that the verbose Vitest reporter prints individual named synthetic case outcomes rather than a quality score, and state that live provider and consumer canaries remain separate. Update the fixture README with the category-to-case mapping and evidence limitations.

- [ ] **Step 4: Run CI-contract and workflow validation**

Run: `npx vitest run tests/ci.test.ts`

Expected: PASS, including the script/order/no-secrets assertions.

Expected: the existing `actionlint` CI job validates the updated workflow and both templates; do not install or add an actionlint dependency locally.

- [ ] **Step 5: Run the full verification set**

Run: `npm run build && npm run evals && npx vitest run && node --check dist/index.js && git diff --exit-code -- dist/index.js && git diff --check`

Expected: every command exits 0; the build does not change `dist/index.js` because this task does not change product source. The existing CI `actionlint` job must also pass before merge.

- [ ] **Step 6: Commit Task 4**

```bash
git add docs/evaluation-harness.md tests/fixtures/evals/README.md .github/workflows/ci.yml tests/ci.test.ts
git commit -m "ci: run deterministic review evaluations"
```

---

## Final verification

- [ ] Run `npm run build && npm run evals && npx vitest run`.
- [ ] Run `node --check dist/index.js`.
- [ ] Confirm the existing CI `actionlint` job passes for `.github/workflows/ci.yml` and both workflow templates.
- [ ] Run `git diff --exit-code -- dist/index.js` and `git diff --check` to verify the build leaves the committed bundle unchanged and introduces no whitespace errors.
- [ ] Confirm no secrets, network requests, live provider calls, or scanner executables are used by the eval suite.
- [ ] Confirm per-case Vitest names and the manifest completeness assertion enumerate all approved scenario categories, with no aggregate model-quality score.
- [ ] Confirm the final diff does not change product source, provider behavior, review policy, templates, or canary configuration.
