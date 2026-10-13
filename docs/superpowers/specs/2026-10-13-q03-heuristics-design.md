# Q03 heuristic evidence — design spec

Date: 2026-10-13 | Status: draft (design approved: approach A) | Branch: `q03-heuristics`
Policy: `docs/superpowers/decisions/2026-10-12-q01-q04-policy.md` (Q03 section, binding)
Audit: `PROJECT_FINDINGS.md` Q03 (path heuristics block legitimate cleanup)

## 1. Goal

Heuristic-only findings without direct secret evidence stop existing
entirely — not emitted, not downgraded. Four categories from the binding
policy: deletions, public certificates, placeholders, unchanged TODO context
lines. The audit's cases (deleted `certs/public.pem` high, TODO on unchanged
context lines) emit nothing; a newly added private key and a real-value
`.env` assignment still flag. Secret scanners (gitleaks/trivy/semgrep) own
content-secrets everywhere and are the backstop — fastpath keeps only the
evidence-backed tripwire.

## 2. Approach (approved)

Content-gated `runL0` + add-only TODO. `sensitive-path` requires a
non-deleted file AND added-line content proving secret material
(private-key markers; non-placeholder `.env` assignments); cert-only,
placeholder-only, content-less, and deleted files emit nothing.
`todoMarkers` scans added lines only. Rejected: name-based lists only
(gameable both directions, keeps banned heuristic-only findings); deleting
the heuristics outright (loses the added-private-key tripwire).

## 3. Interfaces

```ts
// fastpath.ts — no Finding shape change (fields already exist)
export function runL0(files: FileDiff[], o?: { hasManifestFor?: (lockfile: string) => boolean }): Finding[];
// fastpath.ts — new pure helpers (exported for units)
export function hasPrivateKeyMarker(addedLines: string[]): boolean;
export function isPlaceholderValue(value: string): boolean;
export function addedLines(hunks: string): string[]; // "+" lines + unprefixed headerless-content lines; skips " ", "-", "\\" Single classification rule: also applied inline in todoMarkers (which needs line numbers) — one rule, two call sites, no divergent filters.
// diff.ts — unchanged (FileDiff.deleted?: boolean already exists, Q02)
```

## 4. Exact behavior

- **Deletion skip.** `runL0` skips file entries with `deleted === true`
  entirely, all rules (deleted files introduce nothing — the literal policy
  reading; reuses Q02's marker). Surviving files are evaluated on added
  content; pure line-removals in a surviving file are not "deletions".
- **Content rule (`sensitive-path`, stays `high` — with direct evidence it
  is no longer heuristic-only).** For non-deleted sensitive paths
  (`isSensitivePath` unchanged, `ENV_TEMPLATES` unchanged), inspect
  `addedLines(f.hunks)`:
  - Private-key marker on any added line (leading-whitespace tolerant):
    `/^-----BEGIN (?:RSA |OPENSSH |EC |DSA |ENCRYPTED )?PRIVATE KEY-----/`
    → flag. Certificate-only content (`BEGIN CERTIFICATE`, no private-key
    marker anywhere in added lines) → silent.
  - `.env`/`.env.*` files: flag iff an added assignment line
    `/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/`
    (non-comment; `#`-led lines skipped) carries a non-placeholder value
    OR any added line carries a private-key marker (PEM blocks in env).
  - No added content (empty, binary, hunk-less, mode-only hunks) → silent
    (no content means no evidence — the decided rule; scanners backstop).
  - `id_rsa` follows the same uniform content rule, no name exception.
- **Placeholder set (pinned, minimal).** Strip surrounding single/double
  quotes, trim; placeholder iff empty OR case-insensitive match of:
  `changeme`, `change-me`, `example`, `sample`, `test`, `testing`, `xxx`,
  `password`, `password123`, `123456`, `placeholder`, `none`
  OR pattern: `/^x+$/i`, `/^<[^>]*>$/`, `/^\$\{[^}]*\}$/`, `/^\*+$/`,
  contains `example` (case-insensitive — covers `AKIAIOSFODNN7EXAMPLE`,
  `ghp_EXAMPLE_*`). Anything else is real. Evasion by novel placeholders
  is accepted (scanners backstop real-shaped secrets).
- **Message text UNCHANGED** (`Sensitive file path changed: ${file}` —
  emission itself is now the evidence-backed claim; avoids pin churn;
  `source: "fastpath"`, `confidence: 50` unchanged).
- **TODO rule.** `todoMarkers` scans `+`-prefixed lines and unprefixed
  headerless-content lines only; `" "` context, `-`, and `\` lines skipped.
  Added TODOs stay `info`; unchanged-context TODOs vanish.
- **Untouched.** `large-file`, `binary-note`, `lockfile-without-manifest`;
  Finding shape; `isFinding`/sanitize/redact; gates (`eventFor`/`exitFor`);
  Q02 partition/reopen (emission is upstream of gating — no gate-code
  changes); SARIF/artifact; F15 mechanics (counts shrink — expected).
- **Q02 pin interaction (explicit).** Q02's "lineless-in-touched-file
  blocks" rule now applies only when a finding is emitted. Pins that plant
  content-less `sensitive-path` fixtures flip and are reworked in-plan
  (known: `tests/main.test.ts:1257` gate test,
  `tests/fastpath.test.ts:20,76-84,86-94` — enumerated in §6).

## 5. Tests

- Emission matrix (`tests/fastpath.test.ts`): deleted sensitive file →
  nothing (all rules); cert-only `.pem` addition → nothing; private-key
  `.pem`/`id_rsa` addition → high; placeholder-only `.env` → nothing;
  real-value `.env` → high; empty/binary/hunk-less/mode-only sensitive →
  nothing; `export`-prefixed + quoted values; `#` comments skipped;
  `todoMarkers` context-line TODO → nothing, added-line TODO → info
  (incl. headerless).
- Helper units: `hasPrivateKeyMarker` (each marker variant + negative
  cert-only); `isPlaceholderValue` (every pinned literal + pattern +
  negative real values like `ghp_live...`, `correct-horse-...`).
- Reworked pins: fastpath `:20` (id_rsa fixture gains key content),
  `:76-84` (content-bearing fixtures; hunk-less trio asserts silence),
  `:86-94` (`.env.local` gains a real assignment; templates still silent);
  main.test `:1257` keeps a blocking-path test via a key-content id_rsa
  fixture + adds the silence variant (content-less → COMMENT + exit 0).
- Evals: new `cases.ts` pair — private-key addition flags inline,
  cert-only addition silent (no body item); bundle pins.
- Full suite + evals green; `failLevel` semantics unchanged (fewer findings,
  same gates).

## 6. Implementation split (plan preview)

Two sequential tasks: (i) deletion skip + content helpers + sensitive-path
gating (`deleted` continue, three helpers, `sensitive-path` rewrite,
`isSensitivePath`/`ENV_TEMPLATES`/message unchanged, helper + matrix units,
fastpath pin rework); (ii) TODO add-only + Q02-pin rework + evals + docs
(`todoMarkers` line filter, main.test `:1257` rework + silence variant,
evals pair, README heuristic-behavior note). Task (ii) consumes (i)'s
helpers; no parallel work. Single task also acceptable if the implementer
prefers — controller decides at plan time.

## 7. Constraints and residuals

No new runtime dependencies, no new action inputs, stable namespace
(`pr-reviewer-*`, `lupa:` prefixes), no template/CI changes, `dist/`
committed per task, suite + evals green. Ships with the next release
vehicle — no tag alone. Accepted residuals: scanners backstop all
content-secrets (the fastpath tripwire is a convenience, not the
detection floor); placeholder-list evasion; renamed-file attribution rides
hunks (new content — fine); mode-only/binary `.env` silent even if a real
secret hides inside (gitleaks scans the checkout regardless).
