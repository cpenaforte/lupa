# Deterministic quality and integration evaluation harness

**Status:** Draft for review
**Date:** 2026-10-11

## Mission and context

Lupa is a self-hosted GitHub Action for reliable, actionable pull request reviews, including routine review of AI-generated changes. It must remain usable without an LLM key, support optional BYOK inference, avoid maintainer-paid inference, and run without a hosted service or database. A deterministic evaluation harness should catch regressions in the complete review path while keeping synthetic test evidence distinct from live provider and consumer canaries.

The repository already has complementary test seams. `src/main.ts` exports `run(env, deps)` and defines the injected GitHub `Gateway` and `Analysis` boundaries. `tests/main.test.ts` exercises orchestration with fake boundaries. `tests/agent.test.ts` runs the production agent loop with scripted `AgentHooks`. CI builds and smoke-tests the committed `dist/index.js`, but the current smoke event does not trigger a review. The bundle exports `run`, and its entry guard prevents importing it from launching `main()`.

The harness will join these existing seams into a deterministic corpus. It will exercise the committed bundle's review orchestration with a realistic synthetic PR environment and in-memory fakes. It will not claim to measure whether a live model can discover vulnerabilities.

## Desired outcome

A developer can run one documented local command to execute a versioned set of assertion-based review evaluations. CI runs the same evaluations after building the bundle. The suite uses no secrets, remote services, provider inference, or network calls.

Each case has explicit expected findings and locations, safe-control expectations, action status, and publication behavior. A failing assertion identifies the case and contract that regressed. Results show which named cases passed; they are not collapsed into a score or described as evidence of general model quality.

## Design

### Evaluation runner and boundaries

Import the committed `dist/index.js` as a module and invoke its exported `run(env, deps)` with a synthetic `RunEnv`. This exercises bundled orchestration while avoiding the real entrypoint and its production adapters. Assert that importing the module does not launch the action.

Provide an in-memory fake `Gateway` that records PR reads, review attempts, issue comments, and publication payloads. It can return controlled PR metadata and simulate a moved head or read-only fork token. Provide a fake `Analysis` boundary that records the prompt and returns case-scripted scanner, L2, and LLM results. The fake LLM response is deterministic fixture data; tests must assert relevant prompt inputs and final outcomes so the harness verifies wiring and publication, not just fixture parsing. Tests must not call `fetch`, real GitHub APIs, provider endpoints, scanner executables, or other network services.

Keep agent-loop evaluation in-process as well. Use the production `runAgent` with scripted hooks that return a bounded tool-call sequence and final response. Give it a temporary synthetic repository and assert the tool output, final findings, locations, and call/turn accounting. This validates tool-loop integration without provider protocol traffic; provider adapters remain covered by their existing focused tests.

### Versioned synthetic corpus

Store case metadata and associated patch/repository fixtures under a dedicated `tests/fixtures/evals/` tree. Each case has a stable ID, category, synthetic rationale, PR event context, diff, repository snapshot when needed, deterministic fake analysis response, and explicit expected assertions. The harness validates that the manifest includes every required category and runs every case as a separately named Vitest test.

The corpus covers:

- positive seeded bugs with expected finding content and changed-line locations;
- safe-negative and repaired controls with no unexpected finding or inline comment, while asserting the existing clean-review status and payload;
- a deletion case whose expected finding/comment location follows the actual deleted-line diff contract;
- a force-push during review, which must follow existing stale-head publication behavior;
- a fork with a read-only token, which must produce its summary and avoid review/issue-comment writes under current behavior;
- a large diff, which exercises the existing `maxDiffChars` diff truncation and `PER_FILE_CAP` behavior with visible truncation/omission notes; it does not assert a whole-request prompt budget, which belongs to F10;
- an unchanged vulnerable baseline, represented as repository context outside the PR's changed lines.

The unchanged-baseline case tests current diff anchoring and publication behavior only. It must not prescribe suppression, baseline comparison, or blocking policy that belongs to Q02. The fork case must not change the token or privileged-publication policy owned by F14. The corpus must not pull in F09, F10, F11, F13, F15, or Q01–Q04 behavior changes as implementation requirements.

### Assertions and reporting

For each case, assert the expected structured findings (including rule, severity, file, line, message, and remediation where supplied), the relevant prompt/diff content, the resulting exit status, and the exact publication path and payload. Assert that safe controls do not produce unexpected findings or inline comments, while preserving the current clean-review publication contract. For force-push and read-only cases, assert the expected summary-only/degraded behavior and that prohibited review or issue-comment writes did not occur. For large-diff cases, assert the included diff excerpt respects `maxDiffChars` and `PER_FILE_CAP` and that applicable current truncation/omission notes are visible; do not assert a bound on the complete model request, which belongs to F10.

Report case IDs and pass/fail status through Vitest's named tests, and include a manifest-completeness assertion listing absent required categories. Do not compute a single accuracy, quality, or pass-rate score. Fixtures and test descriptions must state that the PRs, findings, and model responses are synthetic and that the corpus checks known regression contracts rather than general review quality.

### Local and CI execution

Add a dedicated npm script for the evaluation suite and document the local sequence: install dependencies, build the bundle, then run the eval script. In `.github/workflows/ci.yml`, run that same script after `npm run build` in the existing build job, before bundle syntax and committed-bundle checks. This ensures CI exercises the exact bundle produced from the checked-out sources.

The eval command must require no secrets and must not access a provider or network. A deterministic local run is the CI gate. Live provider tests and the `test-lupa` consumer canary remain separate evidence and are never silently folded into the deterministic result.

## Alternatives considered

- Testing only `src/main.ts` is fast and matches the existing unit seam, but would not catch a regression unique to the committed bundle. Keep those tests and add bundle-level corpus coverage.
- Launching `dist/index.js` as a full process against local HTTP GitHub and LLM servers would exercise production adapters, but adds network fixtures, scanner shims, event-environment plumbing, and more failure modes. Existing adapter tests already cover the provider and GitHub wrappers; the harness should focus on the bundled orchestration contract.
- Calling a real provider against seeded PRs would measure provider-specific behavior, require credentials and introduce nondeterminism. Keep that as a separately labeled optional canary, not a CI gate.

## Scope boundaries

In scope: deterministic synthetic fixtures; the committed bundle's exported orchestration path; fake GitHub and analysis boundaries; one actual agent-tool round case with scripted hooks; assertions for finding content/location, safe controls, status, and publication; a local command and CI integration; documentation of evidence limits.

Out of scope: changing review behavior or policy; training, benchmarking, or ranking live models; adding real-provider inference to CI; changing provider/GitHub adapters; altering scanner coverage; assigning a general-quality score; implementing later F-number findings or Q01–Q04 policies; changing consumer templates or canary workflows.

## Acceptance criteria

1. The corpus is versioned, has stable case IDs, and a completeness assertion enforces every approved category.
2. The positive, safe-negative, and repaired cases assert structured findings and changed-line locations or their absence, plus action status and publication output.
3. Deletion, force-push, fork, large-diff, and unchanged-baseline cases exercise their documented contracts without changing unresolved policy.
4. The integration evaluations invoke `run()` from the committed `dist/index.js` with in-memory fakes; importing the bundle does not execute `main()`.
5. At least one agent case runs production `runAgent` through deterministic tool and final-response rounds, and checks tool output and final finding data.
6. Eval tests make no network requests, require no secrets, invoke no external scanner, and make no live provider calls.
7. The same npm eval script passes locally and in CI after the bundle build; CI output identifies individual case results.
8. Fixture documentation states the corpus is synthetic and does not prove general live-model review quality; no aggregate score is reported.
9. Existing full Vitest, TypeScript, build, bundle syntax, and CI validation remain in force.

## References

- `src/main.ts`: exported `run(env, deps)`, `RunEnv`, `Gateway`, `Analysis`, and bundle entry guard.
- `src/agent.ts`: production `runAgent` and scripted-hook boundary.
- `src/agent-tools.ts`: tool context and deterministic read-only tool execution.
- `tests/main.test.ts`: existing fake GitHub/analysis orchestration patterns.
- `tests/agent.test.ts`: existing deterministic agent-loop tests.
- `tests/github.test.ts` and provider adapter tests: focused production-adapter coverage.
- `.github/workflows/ci.yml`: current build, bundle smoke, and test sequence.
- `package.json`: local test and build scripts.
- `docs/e2e-checklist.md`: separately identified live provider and consumer validation.
