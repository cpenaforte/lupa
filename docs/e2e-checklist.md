# End-to-end checklist

Manual checks against a disposable consumer repository, run on the **canary**: the immutable
`v0.1.0` tag, before the marketplace listing goes live. Each case lists the PR to create and the
assertions to verify. The unit tests cover the mapping logic (`eventFor`, `exitFor`, `buildBody`);
these cases cover the wiring in a real GitHub run, including live Ollama, which CI does not run.

Setup: a private test repository with the workflow from `docs/workflow-template.yml` pointing at
`@v0.1.0`, `vars.PR_REVIEWER_MODEL` and `secrets.LLM_API_KEY` set, and `fail_level: warning`
unless a case says otherwise. Read the review body on the PR, the job summary, and the
`pr-reviewer-out` artifact.

Every case asserts, in addition to its own rows:

- the artifact `pr-reviewer-out` contains `diff.patch`, `pr-meta.json`, `findings.json`, `sarif.json`, `sbom.cdx.json` (where the scanner ran);
- the LLM key value never appears in the job log, the summary, the review body, or any artifact;
- the workflow exit code matches the `exit-code` output (`0` pass, `2` warning, `1` high).

## Cases

| # | Synthetic PR | Expected event | Expected body / findings | Expected exit |
|---|---|---|---|---|
| 1 | **Secret leak**: adds `const KEY = "AKIA…"` (a fake AWS-shaped key) to `src/config.ts` | `COMMENT` (`fail_level: warning`); `REQUEST_CHANGES` only with `fail_level: high` | gitleaks finding anchored to `src/config.ts:<line>`; the secret value is **not** repeated in the body | `2` (warning) or `1` (`high`) |
| 2 | **SQL injection**: `db.query("SELECT * FROM u WHERE id=" + req.query.id)` added in a route | `COMMENT` (`warning`) | LLM finding inline on the added line; no finding on untouched lines | `2` |
| 3 | **Race**: unsynchronised shared counter updated from two async handlers | `COMMENT` | LLM finding that cites the shared variable; severity may be `warning` (not asserted to be `high`) | `2` |
| 4 | **Giant diff**: >60 000 changed characters across many files | `COMMENT` | Review still posted. Body/summary notes truncation; `diff.patch` in the artifact is untruncated; the prompt input is capped (`max_diff_chars`) | per findings |
| 5 | **Force-push**: push a rewritten history to an open PR branch | `COMMENT` for the new head SHA (`synchronize` event) | Review refers to the new head SHA only; no stale findings from the old head | per findings |
| 6 | **Deleted line**: removes a line that had a finding on the previous head | `COMMENT` | No inline comment on the deleted line (not on the new head's diff); no error | per findings |
| 7 | **Multi-line finding**: LLM reports a range across five added lines | `COMMENT` | Inline comment anchored to a valid added line inside the range; no 422 from the API | per findings |
| 8 | **Fork PR, secrets not granted** (`pull_request` from a fork) | none (no POST) | Summary and artifact only; warning `review not posted; summary and artifact only`; L2 toolchains skipped (`fork PR with secrets in scope`) when secrets are in scope | per findings |
| 9 | **`/review` retrigger** (`issue_comment` `created` containing `/review`, author `OWNER`/`MEMBER`/`COLLABORATOR`) on a PR | `COMMENT` for the current head | Review posted once; the same comment from an external author (`CONTRIBUTOR`/`NONE`) triggers nothing | per findings |

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

Consumers copy the templates from `main` **after** the release. Never copy them from the v0.1.0 tag:
that tag's templates still carry the `OWNER/lupa@0000…` placeholder by design.

Before starting, verify that the scanner digests are real (the scoped test in `tests/ci.test.ts`
checks `src/`, `.github/workflows/ci.yml` and `action.yml` for placeholders):

```bash
grep -cE '^export const (TRIVY|OSV|GITLEAKS)_DIGEST = "sha256:[0-9a-f]{64}";' src/scanners.ts   # must print 3
```

Release order (strict; `v1` moves exactly once, as the last tag move):

1. **Release commit** on `main`. CI is green (`build`, `actionlint`, `smoke`, `no-secret-smoke`,
   `ollama`, `guards`), and `dist/index.js` matches the build. Branding is already declared in
   `action.yml` (`branding:` icon `git-pull-request`, color `blue`).
2. **Immutable tag.** Create an annotated tag on the release commit and push it. The tag is never moved:

   ```bash
   git tag -a v0.1.0 -m "lupa v0.1.0"
   git push origin v0.1.0
   ```

3. **Canary on the immutable `v0.1.0` tag.** In the consumer test repository, pin the workflow to
   `OWNER/lupa@v0.1.0` and run every case above, including live Ollama. All must pass. Do not
   touch `v0.1.0`. If a case fails, fix on `main`, cut a new tag (`v0.1.1`), and restart from step 2.
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
4. **Substitute the tag's commit SHA into BOTH templates**, then commit on `main` (follow-up commit C).
   Get the SHA from the tag, never type it by hand. The first `sed` replaces the placeholder with the
   owner and the SHA; the second drops the stale `# replace with a released SHA` comment. Replace
   `OWNER` with the real owner login before running:

   ```bash
   SHA=$(git rev-parse "v0.1.0^{commit}")
   echo "$SHA"   # 40 hex
   OWNER=your-login
   sed -i "s#OWNER/lupa@0000000000000000000000000000000000000000#$OWNER/lupa@$SHA#" docs/workflow-template.yml docs/workflow-template-privileged.yml
   sed -i 's/ # replace with a released SHA$//' docs/workflow-template.yml docs/workflow-template-privileged.yml
   grep -n "$SHA" docs/workflow-template.yml docs/workflow-template-privileged.yml   # both files, no placeholder left
   npx vitest run tests/templates.test.ts tests/ci.test.ts
   git add docs/workflow-template.yml docs/workflow-template-privileged.yml
   git commit -m "docs: pin templates to v0.1.0 ($SHA)"
   git push origin main
   ```

5. **Move the floating major tag `v1`** to that commit C on `main` (the one that pins the templates).
   The action code at C is identical to the tag's, because the commit only changes docs. Check it:

   ```bash
   git diff --quiet v0.1.0 HEAD -- action.yml dist src   # must exit 0
   git tag -f v1 HEAD   # HEAD is C
   git push --force origin v1
   ```

6. **Marketplace.** On the GitHub release for `v0.1.0`, tick "Publish this Action to the GitHub
   Marketplace". Check the listing copy against `action.yml` (`name: "Lupa"`, the `description`
   field, the inputs and outputs, and the `branding:` block from step 1).
