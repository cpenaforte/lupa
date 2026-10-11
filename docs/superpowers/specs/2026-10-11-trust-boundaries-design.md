# Sub-project 1: trust boundaries — design

Date: 2026-10-11
Status: design approved section-by-section (2026-10-11)
Source: Codex audit `PROJECT_FINDINGS.md` (F01, F02, F03, F08, F12), local HEAD `0458370`
Goal: close every path where a review can execute unintended code, leak credentials,
misattribute evidence, or conceal failed coverage — before any deployment expansion.

## Decisions (approved)

- Ship split: F01 template fix merges to `main` on CI-green with no tag; F02+F03+F08+F12
  ride one SDD run released as `v0.4.0` (new behavior bundle), canary-gated, then
  templates re-pin + `v1` move per the standing release order.
- Standing constraints hold: zero maintainer cost, BYOK-only, stable `pr-reviewer`
  technical namespace, opt-in agent stays read-only, no autonomous writes/commits.

## 1. F01 — venv setup outside the checkout

`docs/workflow-template.yml` only. The semgrep-setup steps get
`working-directory: ${{ runner.temp }}`; the venv is created at
`$RUNNER_TEMP/lupa-semgrep-venv`. Rationale: `python3 -m X` prepends cwd to
`sys.path`, so running setup with the PR checkout as cwd lets a PR-controlled
`venv.py` (or fake `pip` entry point) shadow trusted modules; `RUNNER_TEMP` is
never writable by PR code. Checkout/diff steps do not move. Privileged template
has no Python setup — untouched. Tests pin the working directory and venv path;
actionlint on the template. No `src/` change, no `dist/` rebuild, no tag.

## 2. F02 — redact at every persistence boundary

`src/main.ts` (+ reuse). The exact
key set already established (`github_token` + `llm_api_key`) is applied with
`redactFindings` from `src/review.ts` — the same helper the publish path uses — at
each persistence point: early `writeFindings`
after fast-path, merged `writeFindings`, and the SARIF write. One consistent
boundary for logs, summary, artifacts, and comments. Explicit non-goal, stated in
code comment and README: runtime-key masking only; secrets committed in the diff
are a separate scanner concern and must not be claimed as covered. Tests feed a
synthetic key through each write path and assert `[REDACTED]` with intact structure.

## 3. F03 — stale head skips instead of relabeling

`src/main.ts` publish path. The analyzed SHA is the review's identity. On a
stale-commit 422, drop the post and write a summary/log note naming both SHAs
(analyzed vs live) stating a fresh run will cover the new head; exit 0. Never
re-stamp old findings with a new `commit_id`. The next push/synchronize already
opens a fresh run, so signal is deferred, not lost. The live `getPr` head-check
before posting is unchanged. Tests extend existing 422 coverage: stale head now
asserts no POST with the new SHA plus the skip note.

## 4. F08 — failed scans become warning findings

`src/scanners.ts`. `fromStdout` (and equivalents) record invocation health — exit
code plus `run.executionSuccessful` / execution-error notifications — instead of
accepting any parseable SARIF at face value. A failed/partial invocation emits a
`warning` finding (scanner rule id, e.g. `[scanner-failed]`, naming tool and reason)
as a general review item, alongside usable partial findings, never instead of them.
Clean-empty stays silent; per-scanner "findings found" exit codes keep their meaning.
Fixtures: exit-2 + `executionSuccessful: false` + error notification + zero results
yields exactly one warning; partial yields findings plus warning.

## 5. F12 — validate linked-clone cache before reuse

`src/linked-repos.ts` (+ one `main.ts` touch). When the expected clone dir exists,
`ensureLinkedRepo` verifies before returning: `.git` present, `origin` URL matches
`github.com/<owner>/<repo>`, checked-out ref is the expected default branch (recorded at clone time in a
`.lupa-clone.json` marker next to the clone: `{repo, branch, sha}` — no network
needed on reuse; the marker only names expectations, and every claim is rechecked
against git itself (`git config --get remote.origin.url`,
`git rev-parse --abbrev-ref HEAD`, size walk) before reuse. Any mismatch → wipe
and re-clone under the existing guards/timeouts. The resolved SHA is logged. Failures reuse the existing
"not accessible" tool-error contract, so the model loop is unaffected. Fixtures:
non-git dir, wrong origin, and oversized cache each force re-clone; valid cache is
reused with zero git calls asserted plus SHA logged.

## 6. Verification and release

Standard gates inside the SDD run: full `vitest`, `tsc`, build + `node --check`,
actionlint, non-triggering run exit 0. Canary (test-lupa, focused): synthetic
credential echo (F02 redacted in artifacts, masked in review); forced semgrep
failure (F08 warning posted); linked-clone reuse twice (F12 reuse-or-reclone per
validity). F03 covered by unit + existing 422 test (race not inducible in canary);
F01 validated by CI itself. Release: branch → PR → owner merge → tag `v0.4.0` →
canary on tag → templates re-pin PR → move `v1`.

## Out of scope

Q01–Q04 policy decisions, F04/F05 provider protocols, F10/F11 budgets, F06/F14
publication policy, measurement harness, dedup, docs pass — later sub-projects.
No autonomous writes, commits, shell tools, dashboard, or new integrations.
