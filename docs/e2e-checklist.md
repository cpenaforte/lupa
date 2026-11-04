# End-to-end checklist

Manual checks against a disposable consumer repository, run on the **canary**: the immutable tag of
the release under test (for example `v0.12.0`), before the floating `v1` tag moves to it. Each case
lists the PR to create and the assertions to verify. The unit tests cover the mapping logic
(`eventFor`, `exitFor`, `buildBody`); these cases cover the wiring in a real GitHub run, including live
Ollama, which CI does not run.

Setup: a private test repository with the workflow from `docs/workflow-template.yml`, with the
`cpenaforte/lupa@` pin set to the commit of the tag under test, `vars.PR_REVIEWER_MODEL` and
`secrets.LLM_API_KEY` set, and `fail_level: warning` unless a case says otherwise. Read the review body
on the PR, the job summary, and the `pr-reviewer-out` artifact.

Rerun the matrix against the exact immutable commit of every release under review. Record the action SHA,
workflow run/PR URLs, outputs, and artifact SHAs for each fresh run. No earlier canary result establishes
that a new release passed.

Every case asserts, in addition to its own rows:

- the artifact `pr-reviewer-out` contains `diff.patch`, `pr-meta.json`, `findings.json`, `analysis.json`, `sarif.json`, `sbom.cdx.json` (where the scanner ran); assessment SHAs match the reviewed patch;
- the LLM key value never appears in the job log, the summary, the review body, or any artifact;
- the action process exit matches `exit-code` (`0` pass, `2` warning, `1` high, `3` required non-complete); the separate template gate passes 0/2 and fails 1/3 or missing output;
- `analysis-status`, body, summary, and `analysis.json` agree on execution status and disclose missing coverage even with zero findings. Complete execution is not measured correctness, a human-review replacement, or automatic approval.

## Cases

| # | Synthetic PR | Expected event | Expected body / findings | Expected exit |
|---|---|---|---|---|
| 1 | **Secret leak**: adds `const KEY = "AKIA…"` (a fake AWS-shaped key) to `src/config.ts` | `COMMENT` (`fail_level: warning`); `REQUEST_CHANGES` only with `fail_level: high` | gitleaks finding anchored to `src/config.ts:<line>`; the secret value is **not** repeated in the body | `2` (warning) or `1` (`high`) |
| 2 | **SQL injection**: `db.query("SELECT * FROM u WHERE id=" + req.query.id)` added in a route | `COMMENT` (`warning`) | LLM finding inline on the added line; no finding on untouched lines | `2` |
| 3 | **Race**: unsynchronised shared counter updated from two async handlers | `COMMENT` | LLM finding that cites the shared variable; severity may be `warning` (not asserted to be `high`) | `2` |
| 4 | **Giant diff**: >60 000 changed characters across many files | `COMMENT` | Review still posted. Body/summary notes truncation; `diff.patch` in the artifact is untruncated; the prompt input is capped (`max_diff_chars`) | per findings |
| 5 | **Force-push**: push a rewritten history to an open PR branch | `COMMENT` for the new head SHA (`synchronize` event) | Review refers to the new head SHA only; no stale findings from the old head | per findings |
| 6 | **Deleted line**: report a removed line in the current bound patch | `COMMENT` | Inline comment uses the exact old line on `LEFT`; a line absent from this patch remains body-only advice | per findings |
| 7 | **Multi-line finding**: LLM reports a range across five added lines | `COMMENT` | Inline comment anchored to a valid added line inside the range; no 422 from the API | per findings |
| 8 | **Fork PR, secrets not granted** (`pull_request` from a fork) | none (no POST) | Summary and artifact only; warning `review not posted; summary and artifact only`; L2 toolchains skipped (`fork PR with secrets in scope`) when secrets are in scope | per findings |
| 9 | **`/review` retrigger** (`issue_comment` `created` containing `/review`, author `OWNER`/`MEMBER`/`COLLABORATOR`) on a PR | `COMMENT` for the current head | Review posted once; the same comment from an external author (`CONTRIBUTOR`/`NONE`) triggers nothing | per findings |


Fresh assurance checks for the reviewed release (not yet live pass evidence):

| Scenario | Required result | Advisory control |
| --- | --- | --- |
| Required model timeout or required scanner failure, zero defect findings | `failed`, exit 3, `COMMENT` with execution reason | Existing finding severity exit retained |
| Clipped/omitted semantic hunk, including a defect only in the tail | `incomplete`, exit 3, unreviewed hunks disclosed; no clean claim | Coverage notice, existing severity exit |
| Malformed tool arguments or exhausted agent budget; requested tools unsupported | `incomplete` or `unsupported`, exit 3 even with valid empty final findings | Coverage notice, existing severity exit |
| Remove authorization; finding displayed on unchanged context with an exact removed-line anchor | Gate on causal LEFT anchor; high + `fail_level: high` returns 1 and `REQUEST_CHANGES` when execution is complete | Existing diff/reopen eligibility retained |
| Actor spoof in review prose or producer metadata; repeat with genuine wrongly-resolved thread and display dedup | Spoof never authenticates; genuine raw high reopens independent of display merging | Same identity and raw severity rules |
| Head moves before/during post | Persist `incomplete` on analyzed SHA, exit 3, no stale publication | Persist `incomplete`, exit 0, no stale publication |
| Fork Flow B legacy/missing assessment or hostile producer policy/actor/token | Coverage unavailable or honest producer claim; trusted required policy returns 3 for non-complete; no Analysis calls or privilege escalation | Trusted advisory severity policy retained |
| Workflow/live head SHA differs from producer PR metadata | Refuse publication; do not rerun analysis | Same refusal |
| Healthy requested stages and every eligible hunk accounted for; no findings | `complete`, exit 0, `COMMENT`; human review still needed | `complete` for recorded scope, no approval |
| Non-trigger event or missing gate output | Non-trigger `skipped`/0; missing output fails gate | Same behavior |

Negative controls (run once each):

- `/review` from an external author → no job runs a review, no comment is posted.
- `issue_comment` on a plain issue (no PR) → the job is skipped by the `if:` guard.
- `fail_level: none` on case 1 → exit `0`, review still posted with the warning.

Live Ollama (manual, not in CI): point `llm_provider: ollama` at a local Ollama server with a small
model pulled, open one synthetic PR, and assert the same body and exit-code rules as case 2. CI covers
the ollama code paths with mocks only.

## Local smoke (no LLM, no network beyond the GitHub API)

```bash
npm ci
npx vitest run
npm run build
node --check dist/index.js
test -s dist/index.js
git diff --exit-code -- dist/index.js
```

## Release procedure

Consumers copy the templates (or the workflow in the README) from `main` **after** the re-pin merges.
The templates inside a release tag still pin the previous release.

Before starting, verify that the scanner digests are real (the scoped test in `tests/ci.test.ts`
checks `src/`, `.github/workflows/ci.yml` and `action.yml` for placeholders):

```bash
grep -cE '^export const (TRIVY|OSV|GITLEAKS)_DIGEST = "sha256:[0-9a-f]{64}";' src/scanners.ts   # must print 3
```

Release order (strict; `v1` moves exactly once, as the last tag move). In the commands below, `vX.Y.Z`
is the release and `OLD` is the 40-hex SHA currently pinned in the templates:

1. **Release commit** on `main`. CI is green (`build`, `actionlint`, `smoke`, `no-secret-smoke`,
   `sarif`, `ollama`, `guards`), and `dist/index.js` matches the build. Branding is already declared in
   `action.yml` (`branding:` icon `git-pull-request`, color `blue`).
2. **Immutable tag and pre-release.** Create an annotated tag on the release commit, push it, and publish
   a pre-release with generated notes. The tag is never moved:

   ```bash
   git tag -a vX.Y.Z -m "lupa vX.Y.Z"
   git push origin vX.Y.Z
   gh release create vX.Y.Z --prerelease --generate-notes --verify-tag
   ```

3. **Canary on the immutable tag.** In the consumer test repository, pin the workflow to
   `cpenaforte/lupa@<tag commit SHA>` and run every case above, including live Ollama. All must pass. Do
   not touch `vX.Y.Z`. If a case fails, fix on `main`, cut a new tag (`vX.Y.(Z+1)`), and restart from step 2.
   `v1` has not moved yet, so nothing consumes the failed release.
   - **SARIF check:** to verify the SARIF upload in the canary, enable **both** `security-events: write`
     and `actions: read` in the workflow, then confirm the findings appear in the repository's
     Security tab (Code scanning alerts). With either permission missing the upload fails with
     "Resource not accessible by integration" and `continue-on-error` absorbs it without failing the job
     (a separate warning step reports the failure); that is
     expected, but the canary should exercise the enabled path at least once.
   - **Agent-mode check:** enable `llm_agent: true` on the canary and run two PRs: one that needs
     cross-file context (e.g. a changed function whose caller in another file breaks) and one whose
     body mentions a public linked repo. Verify the job log shows `agent turn ...` lines and
     `agent done: ... stop=final`, plus `agent linked repositories: ...` for the linked-repo PR.
     For a model without tool support, verify the run falls back to single-shot with the warning
     `agent tools unsupported for this model: using single-shot`.
4. **Re-pin pull request.** Substitute the tag's commit SHA into every file that pins the action, then open
   a pull request. Get the SHA from the tag, never type it by hand. The pin appears in the three workflow
   templates, in the README's copy of the minimal workflow, and in `tests/templates.test.ts`:

   ```bash
   NEW=$(git rev-parse "vX.Y.Z^{commit}")
   echo "$NEW"   # 40 hex
   sed -i "s#cpenaforte/lupa@$OLD#cpenaforte/lupa@$NEW#g" docs/workflow-template.yml docs/workflow-template-privileged.yml docs/workflow-template-minimal.yml README.md tests/templates.test.ts
   sed -i "s#@$NEW \# v[0-9.]*#@$NEW \# vX.Y.Z#" docs/workflow-template-minimal.yml README.md
   grep -c "$NEW" docs/workflow-template.yml docs/workflow-template-privileged.yml docs/workflow-template-minimal.yml README.md   # each file: 1
   npx vitest run tests/templates.test.ts tests/ci.test.ts tests/readme.test.ts
   ```

   Rename the release in the pin test's title in `tests/templates.test.ts`, commit as
   `docs: pin templates to vX.Y.Z (<sha>)`, open the PR and merge it when CI is green.
5. **Move the floating major tag `v1`** to the merge commit `C` of that PR on `main`. The action code at
   `C` is identical to the tag's, because the commit only changes docs and tests. Check it:

   ```bash
   git fetch origin main
   git diff --quiet vX.Y.Z origin/main -- action.yml dist src   # must exit 0
   git tag -f v1 origin/main   # origin/main is C
   git push --force origin v1
   ```

6. **Marketplace.** Once the canary has passed, edit the GitHub release for `vX.Y.Z`: clear "pre-release",
   mark it as the latest release and tick "Publish this Action to the GitHub Marketplace". Check the
   listing copy against `action.yml` (`name`, the `description` field, the inputs and outputs, and the
   `branding:` block from step 1).
