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
`readInt(name, fallback, min)` with `min = 1`; invalid input throws the existing
shape `Invalid ${name} "${raw}": expected an integer >= 1 (safe integer)` before
any work) + README:

```yaml
max-findings: 200          # total findings published (inline + body)
max-inline-comments: 30    # inline comments posted
max-review-body-chars: 60000  # under GitHub's 65535 body ceiling with headroom
max-artifact-bytes: 8388608   # read cap for SARIF/SBOM/findings.json (8 MiB)
```

### Ingestion gate (byte caps, no count cap)

Rule: every text about to be JSON-parsed as SARIF, CycloneDX, or findings gets
a byte pre-check against `max-artifact-bytes`. Oversize means no parse is
attempted — not even a partial one.

- File reads (`readFindings` at `src/main.ts:350`, gitleaks report at
  `src/scanners.ts:431`): read at most `max + 1` bytes
  (explicit-length read, never a stat-then-read pair); `bytesRead > max` means
  oversize without ever holding the whole file.
- In-memory texts (semgrep stdout at `src/scanners.ts:284`, SBOM stdout at `:371`,
  gitleaks report text at `:438`, and the `invocationFailed` re-parses at `:288`
  and `:442`): `Buffer.byteLength(text) > max` means oversize.
  (Double-checking an already-checked text is idempotent and cheap.)
- Scanner artifacts (semgrep/gitleaks/trivy stdout, gitleaks report file, SBOM
  docs — including untrusted fork content): oversize →
  `warning("scanner-failed", \`<source> output exceeds the artifact read limit (${max} bytes); results dropped\`)`
  (exact shape; `<source>` is the scanner name). That scanner's results are
  dropped; the run continues visibly degraded — the F08 pattern.
- `findings.json` (required main input in both flows): oversize → throw
  `lupa: findings.json exceeds the artifact read limit (${max} bytes)`
  (exact text, mirroring the existing `lupa: findings.json …` throws). Loud,
  non-zero exit, never clean.
- No count cap at ingest: the full parsed set flows to gating/scoring and to
  the `findings.json`/`sarif.json` artifacts exactly as today.

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
   The dropped set lives only in the artifact.
2. **Inline cap.** `{ inline, general } = mapToComments(retained, hunks)`;
   `posted = inline.slice(0, maxInline)`; excess inline items (still in priority
   order) are appended to `general` — published in the body, just not inline
   (same fold shape as the existing off-diff fallback).
3. **Body char cap.** `body = buildBody(general, summary)`; then markers, then
   cap (markers are always inside the cap):
   - `omitted > 0` → `> Omitted: ${omitted} finding(s) omitted to fit the ${max}-finding publication limit.` (exact)
   - body over `maxChars` → cut content to fit, append `> Note: review body truncated to the ${max}-character limit.` (exact)
   - `maxChars` smaller than the markers themselves → throw `RangeError`
     (mirrors F07 `buildFallbackReport`).
   - The dry-run log line gains `omitted=${omitted}` (observability, not input).

`ReviewPayload` gets the capped `comments` and capped `body`; nothing else in
the payload changes.

### Report/fallback surfaces

- `summaryPath` artifact: unbounded (it is the complete record) — unchanged.
- Issue-fallback body (`postIssueFallback`, a publication surface with the same
  65535 ceiling): capped through `buildFallbackReport(findings, { maxBytes:
  maxReviewBodyChars })` with its existing omission marker. Wired at the F07
  call site in `main.ts`.
- Flow B gets every bound automatically (same `readFindings`, same
  `publishReview`).

## 3. Tests

`tests/review.test.ts`, `tests/main.test.ts`, scanner tests (deps.run/file
fakes — no live GitHub, no docker):

- Oversized SARIF/SBOM fixtures (over the read cap): `scanner-failed` warning
  with the exact text, that scanner's results dropped, parse never attempted
  (assert via the warning shape, not timing).
- Oversized `findings.json`: exact throw text.
- Many-finding fixture (`N > max-findings`): top-N retained in priority order
  (highs first, stable rest), exact `> Omitted:` marker with the count,
  artifact keeps all N, `eventFor`/`exitFor` still see all N.
- Inline-overflow fixture: excess folds to general in priority order.
- Body-char fixtures: truncation marker inside the cap; marker-too-big throws.
- Invalid inputs (zero/negative/non-integer/garbage): input validation error
  before any work.
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
lookup, template/CI changes, new dependencies.
