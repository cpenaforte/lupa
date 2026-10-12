# Sub-project F14: fork publication policy — design

Date: 2026-10-12
Status: draft
Source: Codex audit `PROJECT_FINDINGS.md` (F14), local HEAD `f3e5c05`,
policy record `docs/superpowers/decisions/2026-10-12-q01-q04-policy.md`
Goal: fork PRs get a posted review under one explicit, trusted publication
policy — working credentials by default, matching severity on both sides,
and no silent skips. The untrusted producer artifact never sets publication
policy.

## Decisions (approved in brainstorming)

- Scope: F14 only (`docs/workflow-template-privileged.yml`, `action.yml`
  only if a new input is needed — none planned, `src/main.ts` token gating,
  `src/review.ts` only if event computation moves, owning tests). No adapter,
  template (beyond privileged), or CI changes.
- Credentials: support the trusted workflow-run token (base-repo context,
  already granted `pull-requests: write`); the App stays an optional upgrade.
  Downgrades are always visible, never silent.
- Severity: owner-set input parity — both workflow templates pin the same
  `fail_level`, enforced by `templates.test.ts`. Configuration, never the
  artifact.
- Q02 thread-resolution reads and Q04 provenance/confidence fields are OUT
  of F14 code — recorded as seams below, built later.
- Ship with the whole-plan release — no tag for F14 alone (standing instruction:
  release after the conclusion of the whole roadmap plan).

## 1. Problem

The privileged template presents App-token creation as optional and supplies
`github.token` as a fallback, but the action posts nothing on any fork unless
`tokenIsApp` is true (`canWrite = !isFork || tokenIsApp`): without an App the
template path warns in logs and produces no review. Separately, the privileged
run reports with its own independent `fail_level` default while the producer
gates on its own: producer `high` + warnings-only findings passes the check
while the reporter posts REQUEST_CHANGES. And the privileged side cannot read
the producer's threshold from the artifact — on forks that artifact is built
by attacker-controlled code, which could claim `fail_level: none` to silence
every review into COMMENT.

## 2. Design

### Credential chain (privileged template)

`workflow_run` executes in the base-repo context, so its `github.token`
carries the workflow's own permissions (`pull-requests: write` in the
template) and CAN write reviews on fork PRs — unlike a fork-context token.
The template:

- Keeps the App-token step as-is (optional upgrade; App tokens scope writes
  narrowly).
- Passes `github_token: app-token OR github.token` (unchanged line) plus a
  token-type signal extended to three values: `app`, `workflow-run`,
  `github-token` (`PR_REVIEWER_TOKEN_TYPE`; the fallback arm changes from
  `'github-token'` to `'workflow-run'` — a base-context token, writable —
  while the producer template keeps `'github-token'` for its fork-context
  token. The old two-value writability comparison becomes
  `!== 'github-token'`; `tokenIsApp` keeps its exact App-only meaning
  everywhere else, including the L2 scrub at `main.ts:927`).
- Adds a guard step: without an App token it emits a `::notice::` annotation
  (visible on the PR's checks) that the review posts under the workflow-run
  token and names App setup as the recommended upgrade. Downgrade visible,
  never silent.
- Pins explicit `fail_level: warning` in the Post step's `with:` block
  (today it inherits the action default silently).

### In-action gating (`src/main.ts`)

- `canWrite = !isFork || tokenType !== 'github-token'` (exact replacement of
  `!a.isFork || a.env.tokenIsApp`): App and workflow-run tokens both write;
  only a read-only fork-context token skips — still with the loud warning,
  summary, and artifact, plus the template annotation above.
- `ReadonlyTokenError` paths unchanged (a restricted token that 403s still
  errors loudly; `continue-on-error: true` on the Post step is kept —
  reporting never gates merges).
- `eventFor(inputs.failLevel, fullSet)` / `exitFor` call sites unchanged;
  parity arrives via configuration (below), not code.

### Severity parity (configuration, test-enforced)

- Producer template already pins `fail_level: warning`
  (`docs/workflow-template.yml:147`); privileged template gains the identical
  line. `templates.test.ts` gains a case extracting `fail_level` from both
  templates' Post/action steps and failing on any divergence — same pattern
  as its existing template pins. An owner who changes one side gets a red
  test, not a silent verdict split.
- The artifact is never consulted for publication settings (`fail_level`,
  event, thresholds) — stated invariant; the Q02/Q04 record governs later
  contract additions, not this flow.

### Q-seams (deferred, recorded)

- Q02 thread-resolution state reads join the live-PR check (`getPr` region);
  Q04 provenance/confidence fields join the finding contract. Neither is
  implemented here; `eventFor` already takes the full set, so no signature
  changes are anticipated.

## 3. Tests

Unit/template tests (no live GitHub): token-type matrix for `canWrite`
(app/workflow-run/github-token × fork/non-fork); guard-step annotation text
pinned in `templates.test.ts`; `fail_level` parity case (divergence fails);
producer-threshold-ignored proof (artifact carrying any `fail_level`-shaped
field changes nothing — assert the event from a fixture, not the field).

Consumer canary (owner-run, required): a fork PR against test-lupa with a
warning-severity finding and NO App configured — expect a posted review with
event COMMENT under the workflow-run token plus the downgrade notice on the
checks; then with App configured — expect the notice gone. Record verdicts
in the implementation report.

## 4. Verification and release

- Gates: focused tests, full `vitest`, `tsc --noEmit`,
  `npm run build && node --check dist/index.js`, `actionlint` on the edited
  template, committed `dist/`, required canary above.
- No tag — ships with the whole-plan release.

## Out of scope

Q02/Q04 mechanisms, App-token setup automation, changing `continue-on-error`
semantics, same-repo posting paths, template changes beyond the privileged
file, new inputs, new dependencies.
