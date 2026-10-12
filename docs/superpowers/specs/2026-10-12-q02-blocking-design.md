# Q02 novelty-gated blocking — design spec

Date: 2026-10-12 | Status: draft (design approved: approach A) | Branch: `q02-blocking`
Policy: `docs/superpowers/decisions/2026-10-12-q01-q04-policy.md` (Q02 section, binding)
Audit: `PROJECT_FINDINGS.md` Q02 (repository backlog and PR regressions are mixed)

## 1. Goal

Only PR-introduced findings block. Pre-existing backlog findings stay visible
with provenance but never gate on their own. A past block re-arms — and blocks
again — only when it was wrongly resolved (Resolve clicked while the issue
persists). No persistence check, no reopen.

## 2. Approach (approved)

Diff-membership + thread re-read. The existing `mapToComments` inline/general
split defines "introduced" (in-diff); the reopen exception reads our own PR
review threads' `isResolved` via `octokit.graphql` (bundled in
`@actions/github` via `@octokit/core` — no new dependency) and re-checks
resolved findings against the current scan. No base checkout, no double scan,
no new action inputs. Rejected: base-SHA double scan (cost/complexity),
diff-only without reopen (drops the policy exception).

## 3. Interfaces

```ts
// review.ts — hunk index extracted from mapToComments (display behavior unchanged)
export function indexHunks(hunks: ParsedHunk[]): Map<string, Map<string, HunkLine>>;
// review.ts — gate partition over the merged set (input order preserved).
// introduced = TOUCHED lines only (RIGHT hit with kind === "add" — context and
// LEFT/deletion hits stay display-inline but never gate) PLUS lineless findings
// whose file is in the diff (file-level membership; file "" never matches).
// general = everything else. Display split (mapToComments) is untouched:
// placement ≠ blocking.
export function partitionGate(
  findings: Finding[],
  hunks: ParsedHunk[],
): { introduced: Finding[]; general: Finding[] };
// review.ts — stable identity for thread matching (rule, file, line)
export function reopenedKey(f: Finding): string; // `${rule}\0${file}\0${String(line)}`
// review.ts — pure reopen match (no I/O; threads supplied by the caller;
// general = the gate-path general list, i.e. PRE-CAP merged off-diff)
export function resolveReopened(
  general: Finding[],
  threads: ReviewThread[],
  selfLogin: string,
): Set<string>;
// review.ts — body gains optional reopened set (absent = none; existing 2-arg calls compile)
export function buildBody(general: Finding[], summary: string, reopened?: ReadonlySet<string>): string;
// github.ts — thread read (REST stays as-is; graphql rides the same client)
export interface ReviewThread {
  authorLogin: string | null; // null (deleted account) never matches self
  isResolved: boolean;
  path: string; line?: number; originalLine?: number;
  rule: string | null; // parsed from the first comment body, else null (never matches)
}
export async function listReviewThreads(
  octokit: Octokit, owner: string, repo: string, pr: number,
): Promise<ReviewThread[]>;
// main.ts — Deps.gh gains two methods (harness.ts gateway fake + runWithMocks updated)
listReviewThreads(owner: string, repo: string, pr: number): Promise<ReviewThread[]>;
getActor(): Promise<string | undefined>;
// main.ts — publishReview computes the blocking set BEFORE all early returns
// (dry-run, fork-readonly, stale-head) and returns it for the exits
async function publishReview(a: PublishArgs): Promise<{ blocking: Finding[] }>;
```

## 4. Exact behavior

- **Blocking set.** `partitionGate` over the MERGED set (post-dedup): exact,
  because `mergeable` requires same file AND same line (or both lineless), so
  gate-membership is merge-invariant — no flag rides through `survivor`.
  A lined finding is `introduced` iff its file+line hits a RIGHT-side hunk
  line with `kind === "add"` (touched lines only: `ctx` context lines and
  `LEFT` deletion fallbacks keep their inline display but never gate). A
  lineless finding is `introduced` iff its file is in the diff file set
  (file-level membership — `sensitive-path`/`lockfile-without-manifest` on
  PR-touched files keep blocking; `file: ""` repo notes never match).
  `blocking = introduced + general members whose key is reopened` (order
  preserved). Internally `mapToComments` is refactored onto the shared
  `indexHunks` + hit helper with byte-identical display behavior.
- **Gates read the blocking set.** `eventFor(failLevel, blocking)` in the
  `publishReview` payload; `exitFor(failLevel, blocking)` in `runFlowA`/
  `runFlowB` (replacing `all`/`findings`). The blocking set (including the
  thread read) is computed BEFORE all early returns (dry-run, fork-readonly,
  stale-head) so the dry-run log's `event` and every exit path see it; the
  dry-run `high` count stays on the full set (informational only).
  `eventFor`/`exitFor` signatures unchanged. Everything else keeps today's
  sets: SARIF/`findings.json`/F15 counts on the full merged set; funnel
  (top-N, inline cap, body cap, omission) unchanged; `staleSkipped`
  short-circuit unchanged. Dedup equivalence holds: any high member yields a
  high survivor (severity max) at the same file+line, so pre-merge-full-set
  outcomes equal blocking-subset-of-merged outcomes on the touched-line rule.
- **Reopen match (pure).** Keep a thread iff `isResolved &&
  normalizeBot(authorLogin) === normalizeBot(selfLogin) && rule !== null`
  (`normalizeBot` strips one trailing `[bot]` on each side, covering both API
  conventions; null authors never match). Rule match is INTERSECTION, not
  equality: `thread.rule.split("+")` ∩ `finding.rule.split("+")` ≠ ∅ —
  required because the posted thread rule is the `+`-joined survivor while
  the next run may see unmerged members (same persisting issue at the same
  file+line must still reopen; literal-`+` rules don't exist in any producer,
  accepted). File+line exact, thread line = `line ?? originalLine` (both
  absent → no match). Anything else → no reopen (fail-safe toward
  non-blocking). Reopened findings keep general-body placement with a marker
  (never promoted inline — off-diff lines are uncommentable).
- **Thread fetch.** Single GraphQL query per `publishReview`:
  `repository.pullRequest.reviewThreads(last:100)` with
  `nodes { isResolved path line originalLine comments(first:1) { nodes {
  author { login } body } } } pageInfo { hasPreviousPage }` (`last` keeps the
  NEWEST 100 — recent resolves are the relevant ones). Rule from the
  first-comment body via `/^\*\*(\w+)\*\* \[(.+?)\]/` (the exact `formatBody`
  head shape; lazy by design — a rule containing `]` mismatches fail-safe to
  null). `hasPreviousPage` → warn (`lupa:` prefix) and use the 100. Any fetch
  error → warn + empty set (never blocks on infra failure). No token
  (dry-run without token) → skip silently (expected path; with a token,
  dry-run computes the identical reopen as live).
- **Self identity.** `octokit.rest.users.getAuthenticated()` login, called
  with the same token that posts. Failure → `undefined` → skip reopen with a
  warning. Failure mode is fail-OPEN (feature inert, never a false block).
  Residual: threads posted under a different token identity (e.g. repo
  switched GITHUB_TOKEN → App) won't match — documented, not handled. The
  installation-token behavior MUST be proven on a live canary (test-lupa:
  resolve a posted thread, re-run, observe re-block) before merge — required
  verification, §5.
- **Display.** `buildBody(general, summary, reopened?)`: a reopened general
  item renders `- **<sev>** **reopened** <locate> [<rule>] <msg> ...`
  (marker directly after the severity token; suggestion/trailer otherwise
  unchanged). When at least one general finding is NOT reopened, a header
  note precedes the list (header placement, so later-folded excess-inline
  items never land under it):
  `**Note:** <n> finding(s) below are outside the PR diff and do not block.`
  (`n` = non-reopened general count; omitted entirely when zero; "outside
  the PR diff" is accurate for off-diff, file-not-in-diff, and repo-level
  notes alike.) `summaryFor`, `buildFallbackReport`, SARIF, and artifact
  shapes unchanged — the fallback is a degraded path that already shows
  everything and carries no gate role.
- **"Worsened" scope (explicit narrowing disclosure).** A finding on a
  PR-touched line (added line, or added file for lineless) is in-diff and
  blocks — that is the v1 introduced/worsened rule. Off-diff severity drift
  with no touched line stays non-blocking (true baseline diffing deferred as
  an accepted residual). This narrows the policy's "or worsened" to
  touched-line worsening; ratification happens at spec approval.

## 5. Tests

- New units: `indexHunks` hit parity with `mapToComments` display behavior
  (RIGHT-wins, LEFT-fallback, lineless/fileless → general — display byte-identical);
  `partitionGate` (add-line in, ctx-line out, LEFT-only out, lineless-in-diff-file
  in, lineless-file-absent/`""` out, order preserved); `reopenedKey` shape;
  `resolveReopened` (resolved+self+rule+exact-file+line → key; negations:
  unresolved, foreign author, null author, null rule, line mismatch,
  `]`-in-rule mismatch, both-thread-lines-absent; `originalLine`-only match).
- Fetch units (mocked graphql): last-100 newest, hasPreviousPage warn-truncate,
  error → empty, body-parse incl. unparseable → null, `[bot]`-normalization both sides.
- Gate pins: README-only diff + high in untouched file (incl. high on a ctx
  line of a touched file, and LEFT-only match) → COMMENT + exit 0 with the
  finding still in the body AND the header note; lineless `sensitive-path` on
  an added file → still REQUEST_CHANGES + exit 1; new in-diff high →
  REQUEST_CHANGES + exit 1 (unchanged); resolved-thread-persists (incl.
  joined-rule thread vs unmerged members) → re-blocks with marker;
  resolved-thread-gone → stays resolved; thread-API failure / no token →
  diff-only gating.
- Live canary (REQUIRED before merge): on test-lupa, post a review with a
  high, Resolve its thread without fixing, re-run → re-blocks with marker;
  fix the issue, re-run → stays resolved. Proves identity derivation
  end-to-end on the real API. Without it, the reopen path ships unverified.
- Updated pins: `tests/review.test.ts` `buildBody` expectations gain the
  header note wherever non-reopened general is non-empty (+ marker cases);
  `tests/main.test.ts` gate tests with off-diff/ctx/LEFT highs flip to
  non-blocking; `tests/evals/harness.ts` gateway fake + `runWithMocks` gain
  the two new methods (default: no threads / actor set); `tests/fixtures/evals/cases.ts`
  bodies with general findings gain the header note (finding literals unchanged);
  `README.md` gate table (blocking = in-diff-or-reopened highs), dedup-paragraph
  gate sentence (blocking subset of merged, was "full pre-merge set"), dry-run
  paragraph (event from blocking set), new backlog-note + reopen documentation;
  `tests/readme.test.ts` pins updated ("high-severity finding exists" →
  blocking wording). `eventFor`/`exitFor` unit tests unchanged (signatures same).
- Full suite + evals green; `failLevel` warning/none semantics follow the same
  swap (gates read blocking set at every level).

## 6. Implementation split (plan preview)

Two sequential tasks: (i) gate partition + gate swap + body display
(`indexHunks`, `partitionGate`, `reopenedKey`, `buildBody` marker + header
note, `publishReview` return, Flow A/B exits incl. pre-early-return
computation, README gate docs, pin updates); (ii) reopen check
(`normalizeBot`, `ReviewThread`, `resolveReopened`, `listReviewThreads`,
`Deps.gh` + fakes, publishReview wiring, fetch/match/gate tests, live
canary). Task (ii) consumes (i)'s plumbing; no parallel work.

## 7. Constraints and residuals
No new runtime dependencies, no new action inputs, stable namespace
(`pr-reviewer-*`, `lupa:` prefixes), no template/CI changes, `dist/`
committed per task, suite + evals green. Accepted residuals: off-diff
worsened-severity (no baseline infra); cross-identity threads; >100 threads
warn-truncate; reopened findings past top-N still block but fold out of the
visible body (gates keep the full pre-cap set, dedup precedent).
