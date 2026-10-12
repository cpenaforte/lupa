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

Producer mapping (fixed values, no inference):
- `semgrep`, `trivy`, `gitleaks`, `sbom`, `osv-scanner` (fromStdout label
  as `source`), linter-backed L2: `confidence: 90`, `evidence.analyzer`
  set (tool name; version where already pinned).
- Fastpath heuristics (L0 TODO/path rules, heuristic L2): `confidence: 50`,
  `source: "fastpath"`, no snippet (nothing flagged beyond the match).
- LLM: `source: "llm"` always; `confidence` from a nullable structured
  `confidence` field (same pattern as `duplicateOf` — schema,
  `googleSchema`-safe shape, absent stays absent); `evidence.snippet`
  unset (the message already cites).
- SARIF-parsed findings keep their producing scanner as `source`
  (`parseSarif` gains an optional source parameter — callers pass their
  label; default absent).

### Validation and sanitizers

- `isFinding` accepts the new fields with exact shapes (source: non-empty
  string ≤ 100 chars; confidence: safe integer 0..100; evidence: object
  with optional strings; anything else → contract violation as today).
- `sanitizeFinding` carries all three with caps (`source` like rule-length,
  `snippet` like message-length); absent stays absent through sanitize,
  redact, merge, and funnel — no stage invents values.

### Rendering (display-only; gates untouched)

- Inline bodies: compact trailer `` `src:<source> · conf <n>` `` appended
  after the message/suggestion (omitted when both absent).
- General-body items: same trailer inline.
- Fallback report: `- Source:` / `- Confidence:` / `- Evidence:` rows per
  finding (present fields only).
- SARIF results: `properties: { confidence, source }` (present fields only;
  `message.text` unchanged).
- `findings.json`: stores everything (already does — new fields ride along).

## 3. Tests

Deterministic (mocked LLM): contract validation units (valid/invalid
shapes per field); producer units (fixed 90/50 values, source strings,
analyzer set); LLM structured-confidence extraction (present/absent/
malformed via `okChat`); sanitizer carry + caps + absent-stays-absent;
rendering assertions per surface (inline trailer, body items, fallback
rows, SARIF properties, artifact round-trip); no-LLM and agent runs
(absent everywhere); F15 counts and gate outcomes unchanged.

## 4. Verification and release

- Gates: focused tests, full `vitest`, `tsc --noEmit`,
  `npm run build && node --check dist/index.js`, committed `dist/`.
- No canary (mock-pinned paths); ships with the next release vehicle.

## Out of scope

Q01–Q03 mechanisms, gate/blocking changes (`eventFor`/`exitFor` untouched),
suggestion rendering, template/CI changes, new inputs or dependencies,
confidence thresholds or corroboration rules.
