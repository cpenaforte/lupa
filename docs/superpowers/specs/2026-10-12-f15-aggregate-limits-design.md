# Sub-project F15: aggregate output limits — design

Date: 2026-10-12
Status: draft
Source: Codex audit `PROJECT_FINDINGS.md` (F15), local HEAD `47d26b9`
Goal: bound every aggregate input and publication surface — finding counts,
artifact reads, review-body size, inline-comment counts — with explicit,
visible outcomes at each bound. Oversized or failed analysis must never read
as clean.

## Decisions (approved in brainstorming)

- Scope: F15 only (`src/main.ts` publication flow + `readFindings`, `src/review.ts`
  mapping/body, `src/github.ts` untouched, `src/scanners.ts` artifact reads,
  `src/inputs.ts` + `action.yml` + README for the new inputs, owning tests).
  No adapter, template, or CI changes.
- Approach C (two gates + one shared helper): bound at **ingestion** (byte caps
  on reads, fail-loud on oversize) and at **publication** (count/char caps with
  markers). Mapping, gating, and scoring in between are untouched; gates
  (`eventFor`/`exitFor`) always see the full pre-publication set, so Q02/Q04
  blocking policy does not change.
- Bounds are new action inputs (owner-tunable), not constants.
- Overflow is body-marker-only: retained findings plus an exact `> Omitted:`
  marker in the posted body; the full set stays in the `findings.json` artifact
  (which already stores everything pre-publication).
- Oversized artifacts fail loudly, F08-style: `scanner-failed` warning for
  scanner artifacts (run continues visibly degraded), throw for the required
  `findings.json` (nothing to continue with — loud, non-zero, never clean).
- No new dependencies. No behavior change when everything fits under the bounds.
- Ship with the whole-plan release — no tag for F15 alone (standing instruction:
  release after the conclusion of the whole roadmap plan).

## 1. Problem

Individual fields are capped, but the program has no overall finding-count,
artifact-read, review-body, or inline-comment limit. Whole-checkout scanners and
untrusted fork artifacts can supply very large arrays. The complete files are
loaded before validation (`readFindings`, `parseSarif`, SBOM/CycloneDX parses),
and `publishReview` posts whatever `mapToComments`/`buildBody` produce in one
consolidated review. A large array can exhaust memory, exceed GitHub API limits
(review body 65535 chars; large `comments` arrays risk 422s), or silently
dominate the review.

## 2. Design

### New inputs

Four positive-integer inputs, `action.yml` + `src/inputs.ts` (existing
`readInt(name, fallback, min)`; invalid input throws the existing
shape `Invalid ${name} "${raw}": expected an integer >= ${min} (safe integer)` before
any work) + README:

```yaml
max_findings: 200               # total findings published (inline + body)
max_inline_comments: 30         # inline comments posted
max_review_body_chars: 60000   # code points; under GitHub's 65535 body ceiling with headroom
max_artifact_bytes: 8388608    # read cap for SARIF/SBOM/findings.json/pr-meta.json (8 MiB)
```
(Action/inputs convention is snake_case: `max_diff_chars` → fields
`maxFindings`, `maxInlineComments`, `maxReviewBodyChars`, `maxArtifactBytes`.
`max_review_body_chars` uses `min = 1000` at input time; the other three use
`min = 1`. The 1000 floor guarantees the §2 markers (~120 B worst case) always
fit, so the `RangeError` below is an unreachable backstop, and "invalid input
throws before any work" holds.)

### Ingestion gate (byte caps, no count cap)

Rule: every text about to be JSON-parsed as SARIF, CycloneDX, findings, or
pr-meta gets a byte pre-check against `max-artifact-bytes`. Oversize means no
parse is attempted — not even a partial one. (Capture note: scanner stdout is
buffered by `execFile` under the pre-existing 256 MiB `MAX_BUFFER` before the
pre-check runs — a bounded-by-constant transient, unchanged from base; the
policy below is what drops oversize results. The memory claim covers artifact
texts; finding arrays are bounded upstream by F10/F11 budgets and at
publication by the funnel.)

- File reads (`readFindings(dir, maxBytes)` — signature gains the cap — at
  `src/main.ts:350`, gitleaks report at `src/scanners.ts:431`, `readPrMeta` at
  `src/diff.ts:187`): read at most `max + 1` bytes
  (explicit-length read, never a stat-then-read pair); `bytesRead > max` means
  oversize without ever holding the whole file. (`diff.patch` is explicitly
  excluded: F10 owns diff sizing and its truncation fixtures pin whole-file
  reads.)
- In-memory texts (semgrep stdout at `src/scanners.ts:284`, SBOM stdout at `:371`,
  gitleaks report text at `:438`): `Buffer.byteLength(text) > max` means
  oversize, checked once at the top of `fromStdout`/the SBOM branch and
  returned early (single warning — the `invocationFailed` re-parses at `:288`
  and `:442` only run on texts that passed).
- Scanner artifacts (semgrep/gitleaks/trivy stdout, gitleaks report file, SBOM
  docs — including untrusted fork content): oversize →
  `warning("scanner-failed", \`<source> output exceeds the artifact read limit (${max} bytes); results dropped\`)`
  (exact shape; `<source>` is the scanner name). That scanner's results are
  dropped; the run continues visibly degraded — the F08 pattern.
- `findings.json` (required main input in both flows): oversize → throw
  `lupa: findings.json exceeds the artifact read limit (${max} bytes)`
  (exact text, mirroring the existing `lupa: findings.json …` throws). Loud,
  non-zero exit, never clean. `pr-meta.json`: oversize → throw in the existing
  `Invalid pr-meta.json …` shape (same fail-loud family, internal metadata).
- No count cap at ingest: the full parsed set flows to gating/scoring and to
  the `findings.json`/`sarif.json` artifacts exactly as today. Quantified
  consequence: a minimal pretty-printed finding is ~90 B, so 8 MiB holds ~90k
  minimal findings but only ~4k full-length ones. Flow B therefore rejects
  artifacts Flow A can write — that is the designed outcome (loud throw, never
  silent, never posts partial), and the input itself is the owner lever: raise
  `max_artifact_bytes` to publish bigger reviews.

### Prioritization helper (the one shared policy)

```ts
// review.ts, exported for tests:
prioritizeFindings(findings: Finding[]): Finding[]
```

Severity rank `high` (0) < `warning` (1) < `info` (2); ties keep input order
(stable — deterministic across runs). Original findings and severities are
never rewritten; the helper only orders.

### Publication funnel (`publishReview`, three stages in order)

Input: the full redacted set (gates already computed or computed from it —
`eventFor`/`exitFor` calls keep receiving the pre-cap set).

1. **Top-N.** `ordered = prioritizeFindings(findings)`;
   `retained = ordered.slice(0, maxFindings)`; `omitted = len - retained`.
   The dropped set lives only in the artifact. Priority governs
   retention/selection; body order below follows mapping order, not rank.
2. **Inline cap.** `{ inline, general } = mapToComments(retained, hunks)`;
   `posted = inline.slice(0, maxInline)`; excess inline items are appended to
   `general` — published in the body, just not inline
   (same fold shape as the existing off-diff fallback).
3. **Body char cap** (units: Unicode code points — `Array.from` length, same
   "chars" as `capText`). Shared helper, exported for tests:
   ```ts
   // review.ts:
   capBody(body: string, maxChars: number, markers: string[]): string
   ```
   Whole-line cuts only (cut backs to the last `\n`, F13 pattern),
   code-point-safe (never splits a surrogate pair); fence-balance is
   best-effort with the trunc-note as witness. `body = buildBody(general,
   summary)`; then markers, then cap (markers are always inside the cap):
   - `omitted > 0` → `> Omitted: ${omitted} finding(s) omitted to fit the ${max}-finding publication limit.` (exact)
   - body over `maxChars` → cut content to fit, append `> Note: review body truncated to the ${max}-character limit.` (exact)
   - `maxChars` smaller than the markers themselves → throw `RangeError`
     (same fail-loud shape as F07 `buildFallbackReport`; unreachable via
     inputs thanks to the 1000 floor — unit-tested directly on the helper).
   - The dry-run log line gains `omitted=${omitted}` alongside the posted
     (post-cap) `inline=`/`general=` counts (observability, not input).

`ReviewPayload` gets the capped `comments` and capped `body`; nothing else in
the payload changes. `eventFor`/`exitFor` keep receiving the full pre-cap set
at the existing call sites.

### Off-diff fold stays under the cap

`postReview` folds inline comments into the body on a 422 off-diff retry —
after the cap above. So `PostReviewOptions` gains `maxBodyChars?: number`,
and the fold path re-runs the shared `capBody` (cut + trunc-note) after
folding. Pre-existing markers stay where they are; the trunc-note (if added)
is last. Without this, ~30 folded comments (~6 KB each at full field caps)
could post a ~180 KB body and a retry-exhausted 422 would rethrow with no
issue fallback. The `main.ts` `createReview` closure forwards the input.

### Report/fallback surfaces

- `summaryPath` artifact (`GITHUB_STEP_SUMMARY`): capped at `SUMMARY_MAX_BYTES
  = 1048576` (the 1 MiB platform ceiling — uploads above it abort), with
  `\n\n> Note: summary truncated to the 1048576-byte platform limit.` (exact)
  This is a platform bound, not an owner input.
- Issue-fallback body (`postIssueFallback`, a publication surface with the same
  65535 ceiling): capped through `buildFallbackReport(findings, { maxBytes:
  maxReviewBodyChars })` (bytes, existing helper — conservative: the code-point
  value as a byte cap is stricter for multibyte text, never looser) with its
  existing omission marker. Wired at the F07 call site in `main.ts`.
- Flow B gets every bound automatically (same `readFindings`, same
  `publishReview`).

## 3. Tests

`tests/review.test.ts` (`prioritizeFindings`, `capBody` units), `tests/main.test.ts`
(funnel, gates-on-full-set, summary cap, dry-run log), `tests/inputs.test.ts`
(new input names/defaults/rejections), scanner tests (deps.run/file fakes —
no live GitHub, no docker). Small limits ride on constructed inputs objects
(e.g. `maxArtifactBytes: 100`) — no env needed:

- Oversized SARIF/SBOM fixtures (over the read cap): `scanner-failed` warning
  with the exact text, that scanner's results dropped, parse never attempted
  (assert via the warning shape, not timing).
- Oversized `findings.json` / `pr-meta.json`: exact throw texts.
- Many-finding fixture (`N > max_findings`): top-N retained in priority order
  (highs first, stable rest), exact `> Omitted:` marker with the count,
  artifact keeps all N, `eventFor`/`exitFor` still see all N.
- Inline-overflow fixture: excess folds to general (mapping order; retention
  order asserted on the retained set).
- Body-char fixtures: whole-line cuts, code-point-safe (emoji shutdown case),
  truncation marker inside the cap; marker-too-big throws (unit-level on
  `capBody`, since inputs floor it away).
- Off-diff fold fixture: folded body re-capped, trunc-note last.
- Issue-fallback cap + summary 1 MiB cap + Flow B bounds (same funnel via
  shared `publishReview`/`readFindings`) + dry-run `omitted=` log.
- Gitleaks report-file read + in-memory `byteLength` checks (semgrep/SBOM/
  gitleaks texts).
- Invalid inputs (zero/negative/non-integer/garbage, body-chars < 1000):
  input validation error before any work.
- README documents the four inputs (extends the `readme.test.ts` agent-inputs
  case).
- Existing tests keep passing with defaults (bounds inactive on small
  fixtures); default paths byte-identical.

## 4. Verification and release

- Gates: focused tests, full `vitest`, `tsc --noEmit`,
  `npm run build && node --check dist/index.js`, committed `dist/`.
- No canary (bounds are inactive under defaults on the canary corpus; changed
  paths are mock-pinned); no tag — ships with the whole-plan release.

## Out of scope

F10/F11 contracts, Q01–Q04 (suggestion rendering, backlog-vs-PR, path
heuristics, blocking provenance — all untouched), F14 fork-publication policy,
changing gate thresholds, SARIF content validation beyond size, `sizeKb`
lookup, `diff.patch` reads (F10 owns diff sizing), linked-issue body fetch
(bounded by GitHub and the F10 prompt budget), template/CI changes, new
dependencies. (Audit note: "preserve overflow in a bounded report artifact"
is met as body-marker + complete `findings.json`, per the approved
body-marker-only decision — not as a separately bounded artifact.)
