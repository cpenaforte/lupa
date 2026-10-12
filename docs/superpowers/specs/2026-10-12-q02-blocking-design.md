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
// review.ts — hunk index extracted from mapToComments (behavior unchanged)
export function indexHunks(hunks: ParsedHunk[]): Map<string, Map<string, HunkLine>>;
// review.ts — blocking partition over the merged set (input order preserved)
export function blockingSet(
  findings: Finding[],
  hunks: ParsedHunk[],
  reopened: ReadonlySet<string>,
): Finding[];
// review.ts — stable identity for thread matching (rule, file, line)
export function reopenedKey(f: Finding): string; // `${rule}\0${file}\0${String(line)}`
// review.ts — pure reopen match (no I/O; threads supplied by the caller)
export function resolveReopened(
  general: Finding[],
  threads: ReviewThread[],
  selfLogin: string,
): Set<string>;
// review.ts — body gains optional reopened set (absent = none; existing 2-arg calls compile)
export function buildBody(general: Finding[], summary: string, reopened?: ReadonlySet<string>): string;
// github.ts — thread read (REST stays as-is; graphql rides the same client)
export interface ReviewThread {
  authorLogin: string; isResolved: boolean;
  path: string; line?: number; originalLine?: number;
  rule: string | null; // parsed from the first comment body, else null (never matches)
}
export async function listReviewThreads(
  octokit: Octokit, owner: string, repo: string, pr: number,
): Promise<ReviewThread[]>;
// main.ts — Deps.gh gains two methods (mocked in tests per runWithMocks pattern)
listReviewThreads(owner: string, repo: string, pr: number): Promise<ReviewThread[]>;
getActor(): Promise<string | undefined>;
// main.ts — publishReview returns the blocking set (additive; callers use it for exits)
async function publishReview(a: PublishArgs): Promise<{ blocking: Finding[] }>;
```

## 4. Exact behavior

- **Blocking set.** `blockingSet` = findings with a diff hit under the SAME
  hit rule as `mapToComments` (RIGHT-then-LEFT on the shared index) PLUS
  general findings whose `reopenedKey` is in `reopened`. Computed on the
  MERGED set (post-dedup): exact, because `mergeable` requires same file AND
  same line (or both lineless), so blocking-ness is merge-invariant — no flag
  needs to ride through `survivor`.
- **Gates read the blocking set.** `eventFor(failLevel, blocking)` in the
  `publishReview` payload; `exitFor(failLevel, blocking)` in `runFlowA`/
  `runFlowB` (replacing `all`/`findings`). `eventFor`/`exitFor` signatures
  unchanged. Everything else keeps today's sets: SARIF/`findings.json`/F15
  counts on the full merged set; funnel (top-N, inline cap, body cap,
  omission) unchanged; `staleSkipped` short-circuit unchanged.
- **Reopen match (pure).** Keep a thread iff `isResolved && authorLogin ===
  selfLogin && rule !== null`; match on exact rule+file+line against the
  PRE-CAP merged general list (top-N must not hide reopen candidates), where
  the thread line is `line ?? originalLine` (both absent → no match).
  Anything else → no reopen (fail-safe toward non-blocking). Reopened
  findings keep their general-body placement with a marker (never promoted
  inline — off-diff lines are uncommentable). Dedup equivalence holds: gates
  move from the pre-merge full set to the blocking subset of the merged set
  with identical outcomes, because members share file+line while survivor
  severity is the max — any high member yields a high survivor at the same
  position.
- **Thread fetch.** Single GraphQL query per `publishReview`:
  `repository.pullRequest.reviewThreads(first:100)` with
  `nodes { isResolved path line originalLine comments(first:1) { nodes {
  author { login } body } } }`. Rule from the first-comment body via
  `/^\*\*(\w+)\*\* \[(.+?)\]/` (the exact `formatBody` head shape); unparseable
  bodies → `rule: null`. `hasNextPage` → warn (`lupa:` prefix) and use the
  first 100 (fail-open). Any fetch error → warn + empty set (never blocks on
  infra failure). No token (dry-run) → skip silently (no warn; expected path).
- **Self identity.** `octokit.rest.users.getAuthenticated()` login, called
  with the same token that posts. Failure → `undefined` → skip reopen with a
  warning. Residual: threads posted under a different token identity (e.g.
  repo switched GITHUB_TOKEN → App) won't match — documented, not handled.
- **Display.** `buildBody`: a reopened general item renders
  `- **<sev>** **reopened** <locate> [<rule>] <msg> ...` (marker directly
  after the severity token; suggestion/trailer rendering otherwise unchanged).
  After the items, when at least one general finding is NOT reopened:
  `\n\n<n> backlog finding(s) above are pre-existing and non-blocking.`
  (`n` = non-reopened general count; omitted entirely when zero.)
  `summaryFor`, `buildFallbackReport`, SARIF, and artifact shapes unchanged —
  the fallback is a degraded path that already shows everything and carries
  no gate role.
- **"Worsened" scope.** A finding on a PR-touched line is in-diff and blocks —
  that is the v1 worsened rule. Off-diff severity drift with no touched line
  stays non-blocking (true baseline diffing deferred as an accepted residual).

## 5. Tests

- New units: `indexHunks` hit parity with `mapToComments` (RIGHT-wins,
  LEFT-fallback, lineless/fileless → general); `blockingSet` (in-diff in,
  off-diff out, reopened back in, order preserved); `reopenedKey` shape;
  `resolveReopened` (resolved+self+rule+exact-match → key; each negation —
  unresolved, foreign author, null rule, line mismatch, originalLine match —
  pinned).
- Fetch units (mocked graphql): 100-thread page, hasNextPage warn-truncate,
  error → empty, body-parse incl. unparseable → null.
- Gate flips: README-only diff + high in untouched file → COMMENT + exit 0
  with the finding still in the body AND the backlog line; new in-diff high →
  REQUEST_CHANGES + exit 1 (unchanged); resolved-thread-persists → re-blocks
  with marker; resolved-thread-gone → stays resolved; thread-API failure →
  diff-only gating.
- Updated pins: `tests/review.test.ts` `buildBody` expectations gain the
  backlog line wherever general is non-empty; `tests/main.test.ts` gate tests
  with off-diff highs flip to non-blocking; `tests/fixtures/evals/cases.ts`
  summaries with general findings gain the backlog line (finding literals
  unchanged); `eventFor`/`exitFor` unit tests unchanged (signatures same).
- Full suite + evals green; `failLevel` warning/none semantics follow the same
  swap (gates read blocking set at every level).

## 6. Implementation split (plan preview)

Two sequential tasks: (i) blocking set + gate swap + body display
(`indexHunks`, `blockingSet`, `reopenedKey`, `buildBody` marker + backlog
line, `publishReview` return, Flow A/B exits, pin updates); (ii) reopen check
(`ReviewThread`, `resolveReopened`, `listReviewThreads`, `Deps.gh` additions,
publishReview wiring, fetch/match/gate tests). Task (ii) consumes (i)'s
plumbing; no parallel work.

## 7. Constraints and residuals
No new runtime dependencies, no new action inputs, stable namespace
(`pr-reviewer-*`, `lupa:` prefixes), no template/CI changes, `dist/`
committed per task, suite + evals green. Accepted residuals: off-diff
worsened-severity (no baseline infra); cross-identity threads; >100 threads
warn-truncate; reopened findings past top-N still block but fold out of the
visible body (gates keep the full pre-cap set, dedup precedent).
