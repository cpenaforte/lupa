# SARIF upload-failure visibility — design spec

Date: 2026-10-13 | Status: draft (design approved) | Branch: `usage-sarif`
Source: `PROJECT_FINDINGS.md` Evolutions §7 ("make optional SARIF failure visible")

## 1. Goal

A failed optional SARIF upload becomes visible (annotation + summary line)
while the job stays green and fork/skipped paths stay silent.

## 2. Approach (approved)

Template-only: give the upload step an `id`, add an outcome-guarded note step
mirroring the privileged template's App-token notice (`:48-54`) — but with
`== 'failure'` (not `!= 'success'`) so skipped-on-fork stays silent.
Rejected: removing `continue-on-error` or failing the job (breaks green/fork
contract); `::error::` (wrong severity for an optional upload).

## 3. Interfaces

```yaml
# docs/workflow-template.yml — upload step gains one line:
- name: "Upload SARIF (same-repo PRs; needs security-events: write + actions: read above)"
  id: sarif
  if: always() && github.event.pull_request.head.repo.full_name == github.repository
  continue-on-error: true
  uses: github/codeql-action/upload-sarif@24c54180a607b1449ed407dd24f251e4e9147c8d # v4.38.3
  with:
    sarif_file: ${{ runner.temp }}/pr-reviewer-out/sarif.json
# New step immediately after (nothing else moves):
- name: "Note SARIF upload failure"
  if: always() && steps.sarif.outcome == 'failure'
  run: |
    echo "::warning::lupa: SARIF upload failed — code-scanning results were not uploaded. Enable security-events: write + actions: read, or ignore if code scanning is not used."
    cat >> "$GITHUB_STEP_SUMMARY" <<'EOF'
    lupa: SARIF upload failed — code-scanning results were not uploaded. Enable security-events: write + actions: read, or ignore if code scanning is not used.
    EOF
```

## 4. Exact behavior

- Guard is `steps.sarif.outcome == 'failure'`: failed uploads warn; skipped
  (fork, `issue_comment`, `workflow_dispatch`) and success stay silent.
  The note step itself only echoes, so it succeeds — always-green preserved.
- `if:` guard, `continue-on-error`, `uses` pin, and step name of the upload
  step are byte-identical (only the `id:` line is added).
- Privileged template untouched (explicit never-uploads, pinned by test).
- No code, no `dist/`, no action inputs, no evals impact.

## 5. Tests

- `tests/templates.test.ts` new pins mirroring the `:234-268` shape: `id: sarif`
  present; guard `always()` + `steps.sarif.outcome == 'failure'`; `::warning::`
  text pinned; summary heredoc pinned; step order (upload → note).
- Existing pins (`:16-27` continue-on-error, `:59-62` SHA pin, `:159-162`
  step name, `:221-232` guard/uses, `:92-98` privileged never-uploads) pass
  unchanged. `:204-210` silent-absorption wording stays true (job still
  passes) — extend the comment block only if a pinned substring requires it;
  prefer no comment edits.
- `actionlint` coverage via `tests/ci.test.ts` (templates already linted).
- Full suite green.

## 6. Implementation split (plan preview)

Single task (one reviewer gate): template edit + test pins. Pairs with the
usage-logging task in one plan; no shared files.

## 7. Constraints and residuals

Stable namespace, no code/`dist`/inputs/evals changes, suite green. Ships
with the next release vehicle — no tag alone. Accepted residual: failure
reason detail (the upload action's own log holds it; the note points there
by naming the permissions).
