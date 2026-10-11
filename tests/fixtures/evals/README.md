# Synthetic bundle evaluation fixtures

Every PR patch, repository file, finding, and model response in this directory is synthetic. These
fixtures check named regression contracts in Lupa's bundled review orchestration. They do not measure
general model quality and provide no evidence about live provider behavior.

The category-to-case mapping is maintained in `cases.ts` and completeness is enforced by the eval
suite:

| Category | Case ID |
| --- | --- |
| `positive` | `synthetic-positive-authz-unguarded-record-read`, `synthetic-positive-command-shell-interpolation` |
| `safe-negative` | `synthetic-safe-negative-greeting-format` |
| `repaired` | `synthetic-repaired-authz-owner-check` |
| `deletion` | `synthetic-deletion-removed-unsafe-branch` |
| `force-push` | `synthetic-force-push-head-moves-before-post` |
| `fork-readonly` | `synthetic-fork-readonly-summary-only` |
| `large-diff` | `synthetic-large-diff-per-file-cap`, `synthetic-large-diff-global-budget` |
| `unchanged-baseline` | `synthetic-unchanged-baseline-not-in-diff` |

Each verbose Vitest result names one synthetic case and reports whether its expected regression
contract passed. These named outcomes are regression evidence only; they are not an aggregate quality
score, a ranking, or a prediction of review quality on real pull requests. Live provider checks and
the `test-lupa` consumer canary remain separate from this corpus and its CI gate.
