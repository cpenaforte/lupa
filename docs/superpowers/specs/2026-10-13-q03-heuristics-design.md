# Q03 heuristic evidence — design spec

Date: 2026-10-13 | Status: draft (design approved: approach A) | Branch: `q03-heuristics`
Policy: `docs/superpowers/decisions/2026-10-12-q01-q04-policy.md` (Q03 section, binding)
Audit: `PROJECT_FINDINGS.md` Q03 (path heuristics block legitimate cleanup)

## 1. Goal

Heuristic-only findings without direct secret evidence stop existing
entirely — not emitted, not downgraded. Four categories from the binding
policy: deletions, public certificates, placeholders, unchanged TODO context
lines. The audit's cases (deleted `certs/public.pem` high, TODO on unchanged
context lines) emit nothing; a newly added private key and a secret-shaped `.env` assignment with a real value still flags. Secret scanners (gitleaks/trivy/semgrep) own
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
export function contentText(raw: string): string | undefined; // one shared classifier: content text without prefix, or undefined for blank/context/removed/header lines. addedLines() maps it; todoMarkers applies it inline while counting new-file lines.
// diff.ts — unchanged (FileDiff.deleted?: boolean already exists, Q02)
```

## 4. Exact behavior

- **Deletion skip.** `runL0` skips file entries with `deleted === true`
  entirely, all rules (deleted files introduce nothing — the literal policy
  reading; reuses Q02's marker). Surviving files are evaluated on added
  content; pure line-removals in a surviving file are not "deletions".
  Disclosed behavior change: `binary-note` on deleted binaries and
  `lockfile-without-manifest` on deleted lockfiles stop emitting (both fire
  on deleted entries today); `large-file` never fired there (size 0 absent).
  Policy-literal, stated here — not in the Untouched list by oversight.
- **Content rule (`sensitive-path`, stays `high` — with direct evidence it
  is no longer heuristic-only).** For non-deleted sensitive paths
  (`isSensitivePath` unchanged; `ENV_TEMPLATES` unchanged by decision — a real
  secret committed under a template name is user error outside heuristic scope,
  and scanners still catch its content), inspect
  `addedLines(f.hunks)`:
  - Private-key marker on any added line, leading-whitespace tolerant:
    `/^\s*-----BEGIN (?:RSA |OPENSSH |EC |DSA |ENCRYPTED )?PRIVATE KEY-----/`
    (PEM + OpenSSH scope explicitly — PGP `PRIVATE KEY BLOCK`, PuTTY PPK,
    and other SSH2-misc formats are out of scope; scanners backstop them)
    → flag. Certificate-only content (`BEGIN CERTIFICATE`, no private-key
    marker anywhere in added lines) → silent. `BEGIN PUBLIC KEY` in a `.pem`
    is silent by construction (pinned by test).
  - `.env`/`.env.*` files: flag iff an added assignment line
    `/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)$/`
    (dotenv subset: plain `KEY=value` only — `#`-led, `KEY+=`, dashed-key, and
    multiline values are skipped, stated scope) meets BOTH: (a) the key is
    secret-shaped, `/(SECRET|TOKEN|PASSWOR?D|PASSWD|PRIVATE|CREDENTIALS?|API[_-]?KEY|AUTH[_-]?TOKEN|ACCESS[_-]?KEY|SESSION[_-]?KEY)/i`
    (`PORT=3000`, `DEBUG=false`, `DATABASE_URL=…` do not match — silent even
    with real-looking values; scanners backstop them); AND (b) the value, after
    trailing-comment strip (`\s+#.*$` — `a#b` keeps its hash) and quote-strip,
    is not a placeholder. Any added line carrying a private-key marker also
    flags (PEM blocks in env), independent of key names.
  - No added content (empty, binary, hunk-less, mode-only hunks) → silent
    (no content means no evidence — the decided rule; scanners backstop).
  - `id_rsa` follows the same uniform content rule, no name exception.
- **Placeholder set (pinned, minimal).** Strip a trailing comment (whitespace + `#...`; `a#b` keeps its hash), trim, strip surrounding single/double quotes, trim again; placeholder iff empty OR `$VAR` reference (`$NAME` / `${...}` — resolved elsewhere, not a committed secret) OR case-insensitive match of:
  literals `changeme`, `change-me`, `sample`, `test`, `testing`, `xxx`,
  `password`, `password123`, `123456`, `placeholder`, `none`, bare `example`;
  anchored doc-prefix patterns `^AKIAIOSFODNN7EXAMPLE`, `^ghp_EXAMPLE`, `EXAMPLE_NOT_A_SECRET` (case-insensitive) — substring `example` elsewhere (e.g. `db.example.com`) is NOT a placeholder;
  shape patterns `/^x+$/i`, `/^<[^>]*>$/`, `/^\${[^}]*}$/`, `/^\*+$/`.
  Anything else is real. Judgment call recorded: a real weak password (`password123`) is silent — the false-positive-cost choice the policy mandates. Evasion by novel placeholders accepted (scanners backstop real-shaped secrets).
- **Message text UNCHANGED** (`Sensitive file path changed: ${file}` —
  emission itself is now the evidence-backed claim; avoids pin churn;
  `source: "fastpath"`, `confidence: 50` unchanged).
- **TODO rule.** `todoMarkers` scans `+`-prefixed lines and unprefixed
  headerless-content lines only, via the shared `contentText` classifier;
  `@@` headers are never content (git appends enclosing-line context that may
  contain markers); `" "` context lines advance the new-file counter but are
  never scanned; `-` and `\` lines are skipped entirely (as today).
  Added TODOs stay `info`; unchanged-context TODOs vanish.
- **Untouched.** `large-file` always; `binary-note` and
  `lockfile-without-manifest` on surviving files (deleted-entry behavior
  moves under the deletion rule above). Scope ruling: the policy's operative
  scope is its four named categories (sensitive-path + TODO rules — the audit
  cites only those sites); the second sentence is read as defining those
  categories, not as a general heuristic ban — otherwise `large-file`,
  `binary-note`, and `lockfile` (useful, non-secret heuristics the audit never
  questioned) would also die. Controller-ruled, stated here.
  Finding shape; `isFinding`/sanitize/redact; gates (`eventFor`/`exitFor`);
  Q02 partition/reopen (emission is upstream of gating — no gate-code
  changes); SARIF/artifact; F15 mechanics (counts shrink — expected).
- **Q02 pin interaction (explicit).** Q02's "lineless-in-touched-file
  blocks" rule now applies only when a finding is emitted. Pins that plant
  content-less `sensitive-path` fixtures flip and are reworked in-plan
  (known: `tests/main.test.ts:1257` gate test,
  `tests/fastpath.test.ts:20,76-84,86-94` plus `:117-120` (context-line TODO
  flips to `[]`; `:113-114` keeps `[41]` via counter-advance) — enumerated in §6).

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
  `:117-120` (context TODO asserts `[]`; `:113-114` counter-advance keeps `[41]`),
  `:86-94` (`.env.local` gains a real assignment; templates still silent);
  main.test `:1257` keeps a blocking-path test via a key-content id_rsa
  fixture + adds the silence variant (content-less → COMMENT + exit 0).
- Evals: new `cases.ts` pair with named fixtures — `q03-key-addition.patch`
  (new `id_rsa` + PEM marker → lineless high → general-body item with
  `**blocking**` marker, REQUEST_CHANGES + exit 1 at `fail_level: high`) and
  `q03-cert-addition.patch` (new `certs/public.pem`, cert-only → no finding,
  clean body, exit 0); bundle pins on both.
- Full suite + evals green; `failLevel` semantics unchanged (fewer findings,
  same gates).

## 6. Implementation split (plan preview)

Two sequential tasks: (i) deletion skip + content helpers + sensitive-path
gating (`deleted` continue, three helpers, `sensitive-path` rewrite,
`isSensitivePath`/`ENV_TEMPLATES`/message unchanged, helper + matrix units,
fastpath pin rework); (ii) TODO add-only + Q02-pin rework + evals + docs
(`todoMarkers` line filter, main.test `:1257` rework + silence variant,
evals pair, README heuristic-behavior note (rewords README:170 "a path match is not proof" to the content-gated rule; keeps heuristic confidence 50 by decision)). Task (ii) consumes (i)'s
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
