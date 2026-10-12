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
// whose file is in the FileDiff file set (binary/mode-only/rename entries have
// no hunks but ARE in the file set; deletions count — preserves today's
// behavior, Q03 revisits heuristics-on-deletion later; file "" never matches).
// general = everything else. Display split (mapToComments) is untouched:
// placement ≠ blocking.
export function partitionGate(
  findings: Finding[],
  hunks: ParsedHunk[],
  files: FileDiff[],
): { introduced: Finding[]; general: Finding[] };
// review.ts — stable identity for thread matching (rule, file, line)
export function reopenedKey(f: Finding): string; // `${rule}\0${file}\0${String(line)}`
// review.ts — pure reopen match over the MERGED set (any position: a resolved
// thread whose line drifted to context/LEFT must still re-block while the
// issue persists)
export function resolveReopened(
  findings: Finding[],
  threads: ReviewThread[],
  selfLogin: string,
): Set<string>;
// review.ts — display threading (all optional/additive; existing calls compile):
// mapToComments marks inline items whose key is reopened; formatBody appends
// the reopened marker; buildBody marks body items and counts the note;
// InlineComment gains optional rule (fold keys; absent = assume blocking)
export function mapToComments(
  findings: Finding[],
  hunks: ParsedHunk[],
  reopened?: ReadonlySet<string>,
): { inline: InlineComment[]; general: Finding[] };
export function formatBody(f: Finding, side: "LEFT" | "RIGHT", reopened?: boolean): string;
export interface InlineComment {
  path: string; line: number; side: "LEFT" | "RIGHT"; rule?: string;
  /* start_line/start_side/body unchanged */
  /* rule is INTERNAL (fold keys only, set by mapToComments): main.ts strips it
  when building payload.comments, so posted payloads, recorded eval payloads,
  and the GitHub call carry exactly today's shape — NO eval pin updates for it.
  The 422 retry path recovers keys via index-aligned commentKeys in
  createReview opts (below), not from the stripped comments. */
}
export function buildBody(
  general: Finding[],
  summary: string,
  marks?: { reopened?: ReadonlySet<string>; blocking?: ReadonlySet<string> },
): string;
// github.ts — thread read (REST stays as-is; graphql rides the same client)
export interface ReviewThread {
  authorLogin: string | null; // null (deleted account) never matches self
  isResolved: boolean;
  path: string; line?: number | null; originalLine?: number | null;
  rule: string | null; // parsed from the first comment body, else null (never matches)
}
export async function listReviewThreads(
  octokit: Octokit, owner: string, repo: string, pr: number,
): Promise<ReviewThread[]>;
// main.ts — Deps.gh gains two methods (owner/repo resolve to context.repo
// inside the real gateway, matching its existing convention; both fakes —
// tests/main.test.ts gatewayFor AND the tests/evals/harness.ts gateway — updated)
listReviewThreads(pr: number): Promise<ReviewThread[]>;
getActor(): Promise<string | undefined>;
// main.ts — publishReview computes the blocking set BEFORE all early returns
// (dry-run, fork-readonly, stale-head) and returns it for the exits.
// getActor + listReviewThreads are SHORT-CIRCUITED when every merged finding
// is already introduced (reopen can add nothing — saves two API calls);
// with an empty token both return empty/undefined at entry (no call, no warn).
// The blocking keys also thread to both fold sites. main.ts foldExcessInline
// reads rule straight off the pre-strip InlineComments. The github.ts 422
// retry folds payload.comments (already stripped), so main.ts additionally
// passes index-aligned commentKeys (null where rule absent) in createReview
// opts alongside blocking; foldComments marks `- path:line (non-blocking)`
// only for index-aligned keys present AND outside blocking (length mismatch
// or null key = assume blocking, no marker — fail-safe toward blocking).
// createReview opts gains `blocking?: ReadonlySet<string>` +
// `commentKeys?: readonly (string | null)[]` (both optional; fakes ignore them).
async function publishReview(a: PublishArgs): Promise<{ blocking: Finding[] }>;
```

## 4. Exact behavior

- **Blocking set.** `partitionGate` over the MERGED set (post-dedup): exact,
  because `mergeable` requires same file AND same line (or both lineless), so
  gate-membership is merge-invariant — no flag rides through `survivor`.
  A lined finding is `introduced` iff its file+line hits a RIGHT-side hunk
  line with `kind === "add"` (touched lines only: `ctx` context lines and
  `LEFT` deletion fallbacks keep their inline display but never gate). A
  lineless finding is introduced iff its file is present in the diff: present
  means the FileDiff entry is NOT marked deleted AND (its hunks text is empty
  OR some parsed hunk line for the file has kind add). Rationale: deletions
  introduce nothing — a lineless hit on a deleted file or a pure
  line-removal file never blocks (Q03 later drops heuristics-on-deletion
  entirely); hunks-less entries (added-empty, mode-only, rename,
  added-binary) always count, since git headers carrying new/deleted mode are
  dropped upstream of FileDiff. parseDiffFiles sets FileDiff deleted marker
  from the deleted file mode header (optional field — existing pins for live
  files are unaffected). Empty-file repo notes never match.
  `blocking = merged.filter(f => introduced(f) || reopened.has(key(f)))`
  (single pass in merged order, so a finding that is both is counted once;
  preserved; reopened matching runs over merged in ANY position, so a
  resolved thread whose line drifted to context/LEFT still re-blocks while
  the issue persists). Internally `mapToComments` is refactored onto the
  shared `indexHunks` + hit helper with byte-identical display behavior.
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
  absent → no match). Scope ruling: ANY own resolved thread with a persisting
  finding re-blocks, not only threads from REQUEST_CHANGES reviews — the
  operative policy sentence (resolved + persists → re-raise) governs over the
  loose past-block framing. Anything else → no reopen (fail-safe toward
  non-blocking). Reopened findings keep their display placement with a marker:
  general-body items render `**reopened**` (never promoted inline — off-diff
  lines are uncommentable); inline items (ctx/LEFT drift) render the same
  marker via `formatBody(f, side, true)`.
- **Thread fetch.** Single GraphQL query per `publishReview`:
  `repository.pullRequest.reviewThreads(last:100)` with
  `nodes { isResolved path line originalLine comments(first:1) { nodes {
  author { login } body } } } pageInfo { hasPreviousPage }` (`last` keeps the
  NEWEST 100 — recent resolves are the relevant ones). Rule from the
  first-comment body via `/^\*\*(\w+)\*\* (?:\*\*reopened\*\* )?\[([^[\]]+)\]/`
  (the `formatBody` head shape, tolerating our own inline reopened marker so a
  re-posted thread stays parseable; lazy by design — a rule containing `]`
  mismatches fail-safe to null). `hasPreviousPage` → warn (`lupa:` prefix) and use the 100. Any fetch
  error → warn + empty set (never blocks on infra failure). No token
  (dry-run without token) → skip silently (expected path; with a token,
  dry-run computes the identical reopen as live).
- **Self identity.** Primary: `octokit.rest.users.getAuthenticated()` login,
  called with the same token that posts. Fallback (defined path when the
  primary 403s on installation tokens): the login of the newest review on
  this PR whose body starts with the lupa summary prefix (via paginated pulls listReviews with the existing paginate helper, per_page 100 — newest match wins, so long-lived PRs past one page still resolve — repo-read scope the run already has; our bodies always open with the summary prefix or the fallback summary). Both sides `normalizeBot`-compared. Both failing →
  `undefined` → skip reopen with a warning. Failure mode is fail-OPEN
  (feature inert, never a false block). Residual: threads posted under a
  different token identity (e.g. repo switched GITHUB_TOKEN → App) won't
  match — documented, not handled. The installation-token behavior MUST be
  proven on a live canary (test-lupa: resolve a posted thread, re-run,
  observe re-block) before merge — required verification, §5.
- **Display.** `buildBody(general, summary, marks?)`: every body item whose key
  is in `marks.blocking` renders a marker directly after the severity token —
  `**reopened**` when also in `marks.reopened`, else `**blocking**` (reachable
  only by lineless-in-diff findings; lined introduced items are inline, never
  in the body). Suggestion/trailer rendering otherwise unchanged. Retained
  items are the same object refs mapToComments received (no cloning, no
  re-split — keys computed directly). When at least one body item is NOT in
  the blocking set, a header note precedes the `**Findings not placed inline:**`
  heading (exact order: `${head}\n\n${NOTE}\n\n**Findings not placed inline:**\nitems`):
  `**Note:** <n> finding(s) below are outside the PR diff and do not block.`
  (`n` = body items outside the blocking set; omitted entirely when zero —
  including the all-reopened and empty-general cases. Folded-only
  non-blocking items (general empty, excess folded) get NO header note —
  their per-item `(non-blocking)` markers are the disclosure.) `summaryFor`,
  `buildFallbackReport`, SARIF, and artifact shapes unchanged — the fallback
  is a degraded path that already shows everything and carries no gate role.
- **"Worsened" scope (explicit narrowing disclosure).** A finding on a
  PR-touched line (added line, or touched file for lineless) is in-diff and
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
- Gate pins: README-only diff + high in untouched file, and high on a ctx
  line of a touched file → COMMENT + exit 0 with the finding still INLINE
  (ctx hits display inline — no body item, no note); LEFT-only high → COMMENT
  + exit 0 with the finding in the body AND the header note; lineless
  `sensitive-path` on a touched file (incl. binary/mode-only entries with no
  hunks, and deleted files) → still REQUEST_CHANGES + exit 1; new in-diff high →
  REQUEST_CHANGES + exit 1 (unchanged); resolved-thread-persists (incl.
  joined-rule thread vs unmerged members, and ctx/LEFT-drifted lines →
  inline `**reopened**` marker) → re-blocks; resolved-thread-gone → stays
  resolved; thread-API failure / no token → diff-only gating; all-introduced
  run → getActor/listReviewThreads never called (short-circuit pin).
- Display pins: lineless-in-diff body item renders `**blocking**`;
  `**reopened**` vs `**blocking**` marker precedence (reopened wins);
  header-note exact order (`head / NOTE / Findings-heading / items`) with
  `n` excluding blocking items (all-reopened/all-blocking → no note);
  folded excess non-blocking item renders `- path:line (non-blocking)` at
  BOTH fold sites (main.ts excess + github.ts 422 path); dry-run log gains
  `blocking=<n>`. Payload comment shape is unchanged (`rule` stripped at
  construction), so `bundle.test.ts` exact comment literals need NO updates.
- Live canary (MERGE GATE for task (ii)): on test-lupa, post a review with a
  high, Resolve its thread without fixing, re-run → re-blocks with marker;
  fix the issue, re-run → stays resolved. Proves identity derivation
  end-to-end on the real API. On canary FAILURE: fix the identity derivation
  and re-canary — task (ii) does not merge with an inert reopen path.
- Updated pins: `tests/review.test.ts` `buildBody`/`formatBody`/fold
  expectations (note order, both markers, fold suffix); `tests/main.test.ts`
  gate tests with off-diff/ctx/LEFT highs flip to non-blocking;
  `tests/main.test.ts:134 gatewayFor` + the `tests/evals/harness.ts` gateway
  fake gain the two new methods (default: no threads / actor set);
  `tests/fixtures/evals/cases.ts` bodies with general findings gain the header
  note (finding literals unchanged), `synthetic-deletion-removed-unsafe-branch`
  exitCode 2 → 0 (LEFT-only warning now non-blocking; inline LEFT display
  unchanged), all other exitCode expectations re-verified (added-line cases
  unchanged); diff-test deleted-section pins gain the new deleted marker (live-file pins unaffected);
  `README.md` gate table (blocking = in-diff-or-reopened highs), dedup-paragraph
  gate sentence (blocking subset of merged, was "full pre-merge set"), dry-run
  paragraph (event from blocking set), new note + reopen documentation;
  `tests/readme.test.ts` pins updated ("high-severity finding exists" →
  blocking wording). `eventFor`/`exitFor` unit tests unchanged (signatures same).
- Full suite + evals green; `failLevel` warning/none semantics follow the same
  swap (gates read blocking set at every level).

## 6. Implementation split (plan preview)

Two sequential tasks: (i) gate partition + gate swap + body/fold display
(`indexHunks`, `partitionGate`, `reopenedKey`, `buildBody` note + `**blocking**`
marker, `InlineComment.rule`, both fold sites + createReview threading,
`publishReview` return, Flow A/B exits incl. pre-early-return computation,
dry-run log count, README gate docs, pin updates); (ii) reopen check
(`normalizeBot`, `ReviewThread`, `resolveReopened`, `listReviewThreads`,
`Deps.gh` + both fakes, publishReview wiring incl. short-circuit,
`formatBody`/`mapToComments` reopened markers, fetch/match/gate tests, live
canary as merge gate). Task (ii) consumes (i)'s plumbing; no parallel work.

## 7. Constraints and residuals
No new runtime dependencies, no new action inputs, stable namespace
(`pr-reviewer-*`, `lupa:` prefixes), no template/CI changes, `dist/`
committed per task, suite + evals green. Accepted residuals: off-diff
worsened-severity (no baseline infra); cross-identity threads; >100 threads
warn-truncate; reopened findings past top-N still block but fold out of the
visible body (gates keep the full pre-cap set, dedup precedent);
outdated-thread line-drift miss (thread `line` null after the finding's line
shifted → `originalLine` misses → stays resolved while persisting).
