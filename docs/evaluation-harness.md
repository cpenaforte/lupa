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

Live provider checks and the `test-lupa` consumer canary remain separate from the deterministic
evaluation gate. See [the fixture catalog](../tests/fixtures/evals/README.md) for the category-to-case
mapping and corpus limits.
