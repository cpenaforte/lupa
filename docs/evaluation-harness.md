# Deterministic evaluation harness

The synthetic review evaluations exercise named regression contracts against Lupa's built bundle.
Run the local sequence from a clean checkout with:

```sh
npm ci
npm run build
npm run evals
```

The verbose Vitest reporter prints each named synthetic case and whether its expected contract
passed. These outcomes show whether the listed regressions remain covered; they do not combine into
a general quality score or predict performance on real pull requests. The fixtures and model
responses are synthetic, and the suite rejects unexpected network requests. The CI evaluation step
needs no provider credentials or service.

Each corpus expectation pins `analysisStatus` and the applicable coverage counters independently of findings, locations, severity exits, and publication content. Every case supplies explicit scanner/L2/model execution evidence; an empty findings list never implies healthy execution. The harness records calls on the actual injected Analysis port, including source overrides, so Flow B's no-analysis assertion cannot accidentally inspect an unused default fake. The committed-bundle suite also installs a rejecting network sentinel for every case and asserts that it was unused, including failures that production could otherwise catch.

Named integration checks cover required model/scanner failures, unknown health, clipped tails, malformed tool arguments through the real read-only executor, unsupported tool fallback, agent budget exhaustion, deletion anchors, actor spoofing, raw dedup/reopen invariance, and complete execution. They pin required stale-head exit 3 against advisory exit 0 at both publication race points. Flow B checks cover legacy and SHA-mismatched assessments, hostile producer policy/actor/token/severity claims, trusted head binding, and publication without Analysis calls. Workflow tests execute the actual gate shell: 0/2 pass, 1/3 and missing/invalid output fail. The CI non-trigger smoke executes the bundle under required policy and checks `analysis-status: skipped` and exit 0, including a negative check for missing outputs.

These are deterministic execution-contract checks. `complete` is not a model-quality score, proof of causal correctness, a substitute for human review, or permission to approve or merge. Source-corpus runs intentionally emit synthetic warnings/errors for refusal, stale, and fallback scenarios; those diagnostics are expected fixture behavior. Live canaries need fresh evidence for the reviewed release and are never inferred from these results or historical runs.

Live provider checks and the `test-lupa` consumer canary remain separate from the deterministic
evaluation gate. See [the fixture catalog](../tests/fixtures/evals/README.md) for the category-to-case
mapping and corpus limits.

## Optional live-model runs and how to judge them

The deterministic suite asserts exact scripted findings; it measures orchestration, not model
judgment. Running the same corpus against a real provider (BYOK key, local only, never CI) needs a
different yardstick — exact `rule` matching scores even a perfect review as a miss, because live
models emit equivalent rules under different names (e.g. `command-injection` for the fixture's
`shell-argument-interpolation`). Judge each case by hand with this rubric:

- **HIT** — same file and line (or the immediately surrounding lines for deletions, which the
  `LEFT`-side contract anchors to the removed line) plus the same defect class, whatever the
  rule id says. Read the finding message; the message is the evidence, the rule id is a label.
- **PARTIAL** — right location but a different defect, or right defect class at a nearby line.
  Check the fixture first: several fixtures admit more than one valid reading (an assignment to
  an undeclared identifier is both a policy violation and a compile error), so a "miss" against
  the scripted rule may be a legitimate alternative, not a model failure.
- **MISS** — the seeded defect is absent and nothing equivalent replaces it.
- **FP-legit** — an extra finding that names a real adjacent issue (a missing null guard next to
  a repaired auth check, an 8 KB string blob in a "clean" large-diff fixture). Noisy but honest;
  consider whether the fixture should be tightened rather than blaming the model.
- **FP-noise** — an extra finding with no basis (style nits on controls, findings on truncated
  content presented as complete). This is the signal that actually compares across models.

Do not combine verdicts into a score. Compare runs case by case across models (a stronger model
typically converts FP-noise to silence while keeping the HITs). Keep live outputs out of the repo:
finding messages may quote diff content and must never be committed as fixtures without review.
