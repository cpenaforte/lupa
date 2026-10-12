# Sub-project Q04: finding provenance and confidence — design

Date: 2026-10-12
Status: draft
Source: Q01–Q04 policy record (`docs/superpowers/decisions/2026-10-12-q01-q04-policy.md`,
Q04: severity blocking stays, provenance + confidence display-only),
audit Q04
Goal: every finding carries where it came from, what proves it, and how
confident the claimant is — rendered everywhere, gating nothing.

## Decisions (approved in brainstorming)

- Scope: Q04 only (finding contract, producers, validation/sanitizers,
  renderers, SARIF, owning tests). No gate, blocking-policy, template, or
  CI changes.
- Contract: `source?: string`, `confidence?: number` (0–100 int),
  `evidence?: { snippet?: string; analyzer?: string }` — all optional.
  Absent = legacy finding (pre-contract artifacts, agent findings,
  unmarked LLM output); never defaulted, never invented.
- Values: deterministic analyzer output = 90; heuristic text matches = 50;
  LLM emits its own 0–100 (absent if unmarked).
- Display everywhere: inline trailer, body items, fallback rows, SARIF
  properties, artifact storage. Gates and severity untouched (display-only).
- Ship with the next release vehicle, no tag alone.

## 1. Problem

The shared contract has no source, evidence, confidence, or baseline
fields: a review shows severity + rule + message with no indication of who
claimed it (deterministic scanner vs heuristic text match vs model
judgment), what proves it beyond prose, or how confident the claimant is.
Triage treats all three identically.

## 2. Design

### Contract and producers

```ts
// fastpath.ts Finding gains three OPTIONAL fields:
source?: string;       // short producer id, non-empty, max 100 chars
confidence?: number;   // integer 0..100
evidence?: { snippet?: string; analyzer?: string };  // flagged lines + analyzer name/version
```

Producer mapping (fixed values, no inference — `osv-scanner` is the fixed
`source` string, never the lockfile-interpolated label, so contract values
stay stable and short):
- `semgrep`, `trivy`, `gitleaks`, `osv-scanner` (the `fromStdout` LABEL —
  never `tool`, which is `"docker"` — applied by the caller wrapping
  `parseSarif` results, not inside `parseSarif`), linter SUCCESS findings
  (gofmt per-file, `runGitleaks` parsed results): `source` = the fixed id
  (`"gofmt"`, `"gitleaks"`, … — like all fixed ids), `confidence: 90`,
  `evidence: { analyzer: <same fixed id> }` (name only).
  "Success" means files parsed: gofmt per-file findings are success-shaped
  even under nonzero exits (only timeout/signal delegate to the failure
  path) — confidence 90 either way.
- Fastpath L0 (TODO/path/large-file/binary/lockfile notes, sensitive-path
  highs): `source: "fastpath"`, `confidence: 50` (heuristic without proof —
  including `high` path findings, policy-consistent).
  Linter FAILURE warnings (`interpretDefault` abnormal exits/timeouts) are
  tool-health: `source` = the `name` argument (already the warning's `rule`
  value — no invention), confidence absent — never 90.
- `warning(rule, message, source?)` gains an optional third parameter
  (non-breaking for existing call sites); `fromStdout` assigns its (mapped)
  label internally, `runGitleaks` passes `"gitleaks"`, the SBOM branch
  `"sbom"`, `byteCheck` maps its label argument internally via
  `sourceForLabel()` (existing `byteCheck` tests with plain labels are
  unaffected — mapping is identity without parens).
- `sourceForLabel(label: string): string` in `artifact-limits.ts`
  (read-policy home alongside `oversizeMessage`/`byteCheck` — no cycles:
  nothing it imports imports it): `label.split(" (")[0]` — identity for
  paren-free labels, `"osv-scanner (lock)"` → `"osv-scanner"`. Used at EVERY
  construction site taking a label (`fromStdout`, `runGitleaks`, SBOM
  branch, `byteCheck` internally), so lockfile paths never reach the
  contract. `fastpath.ts` needs no import (L0 uses the literal).
- Tool-health warnings (`scanner-missing`/`scanner-failed`/`sbom-write`,
  `byteCheck`): `source` = the failing tool's label, confidence ABSENT (no
  evidentiary claim). Synthetic substitutes (`L2_SKIPPED`): `source: "l2"`,
  confidence absent. The SBOM content path emits no findings.
- LLM (single-shot only): `toFindings` assigns `source: "llm"` and carries
  `confidence` from a nullable structured `confidence` field (same pattern
  as `duplicateOf` — schema, `googleSchema`-safe shape, added to the
  `required` lists, absent stays absent; invalid values drop the FIELD,
  never the finding). Agent-mode findings carry NO provenance via a shared
  `stripProvenance()` helper (fastpath.ts) applied at BOTH agent exit
  points — after `agent.ts`'s `toFindings` call AND on slowPath's agent
  branch (which covers the probe-memo path that bypasses `toFindings`
  entirely). No separate agent schema: required keys constrain the
  model's output and models emit them (dedup's required verdict keys set
  this precedent without incident).
  revisit with Q01 structured output (seam noted, not built; agent SYSTEM prompt/contract untouched — only the user message carries provenance, intended). Response
  schema, `prompt.test.ts` required pins, and the converted-schema
  expectation update are named per task.
- `evidence.snippet`: assigned by NO producer in v1 (reserved contract
  field); `redactFindings` redacts `evidence.snippet` and
  `evidence.analyzer` with the same secret keys (a snippet must never
  publish a secret, present or future).

### Validation, sanitizers, and rebuild sites (every site enumerated —
provenance must never drop silently mid-pipeline)

- `isFinding` accepts the new fields with exact shapes (source: non-empty
  string with `.length ≤ 100` (UTF-16 units — deliberately NOT code points,
  diverging from `capText`; validation is a shape check, capping is
  `sanitizeFinding`'s job); confidence: safe integer 0..100; evidence:
  object with optional strings; anything else → contract violation as today).
  Accepted latent: a 60-astral-char source would survive sanitize and fail
  Flow B reads — unreachable, all producer sources are fixed ASCII.
- `sanitizeFinding` carries all three with caps (`source` capped like rule,
  `snippet` like message, `analyzer` capped like rule with control-strip);
  absent stays absent through sanitize, redact, merge, and funnel — no stage
  invents values.
- `survivor` (dedup merge) carries provenance with per-field rules:
  `source` = present member sources `"+"`-joined in group order (collapse
  identical; re-capped at 100 like `rule`; absent iff ALL members absent);
  `confidence` = max (absent ONLY if all members absent — no invented
  values); `evidence` = `{ snippet: first defined, analyzer: distinct
  present analyzers joined "+" re-capped at 100 }`, absent when no member
  defines any evidence field (never an empty object).
- `toFindings` assigns `source: "llm"` + carries `confidence` (single-shot
  only). `redactFindings` spreads (keeps) + redacts `evidence.*`.
  `parseSarif`/`warning()`/`runL0`/L2 interpreters/`byteCheck`/`L2_SKIPPED`
  construct per the producer table (no other shape). `sanitizeFinding` and
  `redactFindings` always create FRESH `evidence` objects when touching them
  (spread shares by reference — redacting in place would mutate objects
  shared across `writeFindings`, `promptFast`, and `all`; copy-on-write,
  pinned by an aliasing test). `mapToComments`,
  `prioritizeFindings`, `capBody` pass findings through untouched.
- Prompt gains nullable `confidence` (schema + `googleSchema`-safe shape +
  single-shot instruction, same pattern as `duplicateOf`); `prompt.test.ts`
  + converted-schema pins update (named per task). The model sees provenance
  via the fast-findings JSON (intended — aids dedup judgment and confidence
  calibration); the extra bytes count against the F10 budget with tail cuts
  as before (deterministic, stated).

### Rendering (display-only; gates untouched)

- Inline bodies: compact trailer `` `src:<source> · conf <n>` `` appended
  after the message/suggestion — AFTER any suggestion fence (never inside a
  patch block); partials: source-only → `` `src:<source>` ``,
  confidence-only → `` `conf <n>` ``, neither → no trailer. `confidence: 0`
  renders (`conf 0` — never truthiness-tested; pinned by test).
- General-body items: same trailer inline, AFTER any `Suggested:` block
  (never inside it). The trailer is part of item text:
  it renders BEFORE any `capBody` cut (never appended post-cap) and may be
  truncated with the item (the truncation note witnesses).
- Fallback report: `- Source:` / `- Confidence:` / `- Evidence:` rows after
  the `- Message/evidence:` row (present fields only; values via the
  existing `field()` fenced helper like neighboring rows; `evidence` =
  `analyzer: <name>` line when present + fenced snippet when present).
- SARIF results: `properties` carries `confidence` and `source` each
  independently iff present (confidence-only → `{confidence}`;
  source-only → `{source}`); omitted entirely when both absent
  (`message.text` unchanged).
- `findings.json`: stores everything (already does — new fields ride along;
  ~60% growth accepted residual: inputs are byte-capped upstream and the
  8 MiB Flow B read cap still guards).

## 3. Tests

Deterministic (mocked LLM): contract validation units (valid shapes;
invalid per field — overlong source, 101/−1/1.5/`"90"` confidence,
non-object evidence); producer units (fixed 90/50 values, source strings
incl. fixed `osv-scanner` + `sourceForLabel` mapping, analyzer set,
tool-health absent-confidence incl. L2 failures, `L2_SKIPPED`
absent-confidence; `warning(rule, message, source?)` units); survivor units
(differing sources join + re-cap, max confidence with all-absent exception,
evidence merge + absent-when-none, cross-file-grouped); LLM
structured-confidence extraction (present/absent/malformed via `okChat`,
field dropped on invalid; schema + converted-schema pins:
`tests/llm.test.ts:361-370` + `:397`, `tests/probe-routing.test.ts:71,118,
154,194,226,324` + `:97-101`, `tests/prompt.test.ts:148`,
`tests/adapters-google.test.ts:550` + toEqual pins, `tests/adapters-routing.test.ts:142,160,178,197`); producer `toEqual` pins updated:
`tests/scanners.test.ts:582,704,709,716,736,746`,
`tests/l2.test.ts:150,161,173` (gofmt incl. nonzero-exit-with-files);
`tests/artifact-limits.test.ts:90-96` (`byteCheck` source now set);
`tests/fixtures/evals/cases.ts:96` + summary `:275-277` verified (updated
iff the trailer renders there); `tests/evals/agent.test.ts:61-69` UNCHANGED
(agent path carries no provenance — pinned by absence);
sanitizer carry + caps + absent-stays-absent; redaction of `evidence.*`
(secret in snippet redacted) + fresh-object aliasing test; rendering
assertions per surface (inline trailer incl. partials + `conf 0`,
trailer-inside-cap truncation, body items, fallback rows order, SARIF
properties present/omitted, artifact round-trip); no-LLM
and agent runs (absent everywhere; `tests/evals/agent.test.ts` pins
unchanged by construction); F15 counts and gate outcomes unchanged;
`tests/artifact-limits.test.ts` `byteCheck` pins updated (source now set);
`tests/fixtures/evals/cases.ts` forkL2Skipped summary verified (updated iff
the trailer renders there).

## 4. Verification and release

- Gates: focused tests, full `vitest`, `tsc --noEmit`,
  `npm run build && node --check dist/index.js`, committed `dist/`.
- No canary (mock-pinned paths); ships with the next release vehicle.

## Out of scope

Q01–Q03 mechanisms, gate/blocking changes (`eventFor`/`exitFor` untouched),
suggestion rendering, template/CI changes, new inputs or dependencies,
confidence thresholds or corroboration rules.
