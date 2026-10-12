# Q04 provenance and confidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every finding carries source, confidence, and evidence end to end, rendered everywhere, gating nothing.

**Architecture:** Task 69 extends the contract with validation, sanitizers, and producer values; Task 70 wires the LLM structured-confidence path; Task 71 renders on all surfaces plus the dedup survivor rules. Sequential (69 → 70 → 71). (Second follow-up of the dedup → Q04 → Q02 → Q01 order.)

**Tech Stack:** TypeScript 5.x, Node >=24, vitest, esbuild (`dist/` committed).

**Spec:** `docs/superpowers/specs/2026-10-12-q04-provenance-design.md`

## Global Constraints

- No new runtime dependencies, no new action inputs, no template or CI changes.
- `PR_REVIEWER_*` env names, `pr-reviewer-*` strings, `pr-reviewer/1.0` user-agent, SARIF driver name, `lupa:` log prefixes unchanged.
- Every task ends with `npx tsc --noEmit -p tsconfig.json`, `npm run build && node --check dist/index.js` and commits `dist/index.js`.
- Full suite (`npx vitest run`) + evals (`npm run evals`) green before every task commit (evals after build).
- Commit messages use the exact strings given per task.
- Ships with the next release vehicle — no tag alone.

## Review Focus

- **A scanner finding with a lockfile-interpolated label still validates and posts with a fixed source.** Test in Task 69's step style (osv label with lock path → `source: "osv-scanner"`, contract-valid).
- **A secret inside evidence text never reaches any output.** Test in Task 69's step style (redaction unit on the snippet) and Task 71's step style (fallback + SARIF assertions on a secret-bearing finding).
- **An LLM reply with `"confidence": 150` keeps its finding with no confidence.** Test in Task 70's step style.
- **Two merged findings with different sources cite both after the merge.** Test in Task 71's step style (survivor `"a+b"`, confidence max).
- **A `confidence: 0` finding renders its trailer instead of dropping it.** Test in Task 71's step style.

---

### Task 69: Q04 — contract, producers, validation, sanitizers

**Files:**
- Modify: `src/fastpath.ts` (Finding fields + L0 values), `src/artifact-limits.ts` (`sourceForLabel` + `byteCheck` source), `src/scanners.ts` (`warning(rule,message,source?)`, fromStdout wrap, runGitleaks label, SBOM label), `src/l2.ts` (success 90 / failure tool-health, gofmt pins), `src/main.ts` (isFinding shapes, sanitize carry+caps, `L2_SKIPPED`), `src/review.ts` (redact evidence + fresh objects)
- Test: `tests/fastpath.test.ts`, `tests/scanners.test.ts` (`:329,339,367,381,418,431,445,458,477,489,500,520,766` + `:582,704,709,716,736,746`), `tests/l2.test.ts` (`:150,161,173` + `:183-185,:193-195`), `tests/artifact-limits.test.ts` (`:90-96`), `tests/main.test.ts` (isFinding/sanitize units), `tests/review.test.ts` (redact incl. snippet secret + fresh-object aliasing), `tests/fixtures/evals/cases.ts` (`:96` forkL2Skipped → gains source, summary `:275-277` verified)
- Rebuild: `dist/index.js`

**Interfaces:**
- Consumes: existing `warning()` call sites — the following pass explicit sources: fromStdout internals (own label via `sourceForLabel`), runGitleaks (`"gitleaks"`), SBOM branch (`"sbom"`), byteCheck (maps internally); all other 2-arg calls compile unchanged. `tests/fixtures/evals/cases.ts` (`:96` forkL2Skipped gains source + summary `:275-277` gains the Source row — certain, not conditional).
- Produces: `Finding.source?: string`, `Finding.confidence?: number`, `Finding.evidence?: { snippet?: string; analyzer?: string }`; `sourceForLabel(label: string): string` (artifact-limits.ts; `label.split(" (")[0]`, identity without parens).

**Exact behavior:**
- Contract: source non-empty with `.length ≤ 100` (UTF-16 units, NOT code points — validation is shape-only, capping is sanitize's job); confidence safe integer 0..100; evidence object with optional strings (else contract violation as today).
- Values: scanners/sbom/gofmt-success `confidence: 90` with `source`/`evidence.analyzer` from `sourceForLabel(label)`; L0 all `source: "fastpath"`, `confidence: 50`; L2 failures + tool-health warnings + `L2_SKIPPED`: source set, confidence ABSENT; `evidence.snippet` assigned by NOBODY (reserved).
- `warning(rule, message, source?)`: third param optional; listed sites pass sources, rest compile unchanged.
- `sanitizeFinding` carries all three (source/analyzer capped via `capText(x, RULE_CAP)` with control-strip; snippet via message cap); `redactFindings` (review.ts) redacts `evidence.*` with same keys; BOTH create fresh `evidence` objects when touching them (copy-on-write — aliasing test: redact then mutate input, output unchanged).

- [ ] **Step 1: Write the failing tests**
  - Contract units: valid shapes; overlong source, `101`/`-1`/`1.5`/`"90"` confidence, non-object evidence → violations.
  - Producer units per Exact behavior (90/50/absent matrix; `sourceForLabel` incl. lockfile label).
  - Sanitizer: carry + caps + absent-stays-absent.
  - Redaction in `tests/review.test.ts`: snippet secret redacted on every surface shape; fresh-object aliasing (mutate input post-redact, output unchanged).
  - Update `toEqual` pins: scanners.test `:329,339,367,381,418,431,445,458,477,489,500,520,766` + `:582,704,709,716,736,746`; l2.test `:150,161,173` + `:183-185,:193-195`; artifact-limits `:90-96`; evals cases `:96` (+ summary `:275-277`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/fastpath.test.ts tests/scanners.test.ts tests/l2.test.ts tests/artifact-limits.test.ts tests/main.test.ts tests/review.test.ts`
Expected: FAIL (no fields).

- [ ] **Step 3: Implement**

Per Exact behavior + Interfaces. `eventFor`/`exitFor`/gates untouched.

- [ ] **Step 4: Run tests + build**

Run: `npx vitest run tests/fastpath.test.ts tests/scanners.test.ts tests/l2.test.ts tests/artifact-limits.test.ts tests/main.test.ts tests/review.test.ts && npx tsc --noEmit -p tsconfig.json && npm run build && node --check dist/index.js && npm run evals && npx vitest run`
Expected: PASS all green (evals after build); build clean.

- [ ] **Step 5: Commit**

```bash
git add src/fastpath.ts src/scanners.ts src/artifact-limits.ts src/l2.ts src/main.ts src/review.ts tests/fastpath.test.ts tests/scanners.test.ts tests/l2.test.ts tests/artifact-limits.test.ts tests/main.test.ts tests/review.test.ts tests/fixtures/evals/cases.ts dist/index.js
git commit -m "feat: finding source, confidence, and evidence contract"
```

---

### Task 70: Q04 — LLM structured confidence

**Files:**
- Modify: `src/prompt.ts` (nullable `confidence` schema + required + single-shot instruction), `src/llm.ts` (`toFindings` assigns `source: "llm"` + carries valid `confidence`, drops invalid field; memo branch at `:855-857` strips findings, keeps `verdicts`), `src/fastpath.ts` (`stripProvenance` helper), `src/adapters/google.ts` (converted expectation), `src/agent.ts` (strip at `:62-66`)
- Test: `tests/llm.test.ts` (`:361-370` + `:397`), `tests/probe-routing.test.ts` (`:71,118,154,194,226,324` + `:97-101`), `tests/prompt.test.ts` (`:148` + `:149-151`), `tests/adapters-google.test.ts` (`:550` + converted pins), `tests/adapters-routing.test.ts` (`:142,160,178,197`), `tests/fastpath.test.ts` (`stripProvenance` units), `tests/agent-probe.test.ts` (`:133-144` only — memo result keeps `verdicts`, findings stripped; all other pins untouched)
- Rebuild: `dist/index.js`

**Interfaces:**
- Consumes: Task 69's contract + validation shapes.
- Produces: LLM findings with `source: "llm"` + optional valid `confidence` (nothing downstream yet — Task 71 renders).

**Exact behavior:**
- Schema: per-item `confidence: {type: ["integer","null"]}` (NO `prefixItems` pattern — scalar, google-safe), added to item `required`; single-shot instruction names the field, appended at the single-shot invocations only (same gate as the dedup verdict instructions — never the shared `SYSTEM` const, so agent prompts stay byte-identical).
- `toFindings`: assigns `source: "llm"`, carries safe-integer 0..100 `confidence`, drops invalid values (field only, finding kept).
- `agent.ts`: shared `stripProvenance()` helper (fastpath.ts — deletes `source`/`confidence`/`evidence`, returns the finding) applied at BOTH agent exit points: after its `toFindings` call (`:62-66`) AND on the `llm.ts:855-857` probe-memo branch (findings stripped there, `verdicts` KEPT as a genuine single-shot judgment). `slowPath` needs no strip code (both upstreams arrive clean, and its agent return already carries no verdicts key).
- Converted-schema expectation gains the nullable confidence (google recursion + `nullable: true`).

- [ ] **Step 1: Write the failing tests**
  - `okChat` extraction: present/absent/malformed (`150`, `"high"`, `3.5` → field dropped, finding kept).
  - `stripProvenance` units (all-fields/no-fields/partial) + both call sites strip (agent `toFindings` path and `llm.ts:857` memo path assert no provenance; memo keeps `verdicts`).
  - `tests/agent-probe.test.ts:133-144` pin gains `verdicts` (memo result) with stripped findings; all other agent-probe pins untouched.
  - Update pins: llm `:361-370` + `:397` (callLlm gains confidence key), probe-routing ×6 + `:97-101`, prompt `:148` + `:149-151`, google `:550` + converted, adapters-routing `:142,160,178,197`. (`tests/evals/agent.test.ts:61-69` needs NO changes — agent strip keeps those exact pins passing, which proves absence.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/llm.test.ts tests/probe-routing.test.ts tests/prompt.test.ts tests/adapters-google.test.ts tests/adapters-routing.test.ts tests/fastpath.test.ts`
Expected: FAIL (no confidence).

- [ ] **Step 3: Implement**

Per Exact behavior + Interfaces. Adapters need no changes (toFindings centralizes). `toFindings` verdict-index alignment preserved (no item filtering).

- [ ] **Step 4: Run tests + build**

Run: `npx vitest run tests/llm.test.ts tests/probe-routing.test.ts tests/prompt.test.ts tests/adapters-google.test.ts tests/adapters-routing.test.ts tests/fastpath.test.ts && npx tsc --noEmit -p tsconfig.json && npm run build && node --check dist/index.js && npm run evals && npx vitest run`
Expected: PASS all green (evals after build); build clean.

- [ ] **Step 5: Commit**

```bash
git add src/prompt.ts src/llm.ts src/agent.ts src/fastpath.ts src/adapters/google.ts tests/llm.test.ts tests/probe-routing.test.ts tests/prompt.test.ts tests/adapters-google.test.ts tests/adapters-routing.test.ts tests/fastpath.test.ts tests/agent-probe.test.ts dist/index.js
git commit -m "feat: LLM structured confidence with agent strip"
```

---

### Task 71: Q04 — rendering, survivor provenance, docs

**Files:**
- Modify: `src/review.ts` (trailer, fallback rows, survivor rules), `src/main.ts` (toSarif properties), `README.md` (provenance section: default chain, conf-50-on-high policy note)
- Test: `tests/review.test.ts` (trailer/survivor), `tests/main.test.ts` (SARIF/artifact), `tests/readme.test.ts` (section sentences), `tests/fixtures/evals/cases.ts` (summary `:275-277` gains the `- Source:` fallback row — certain, T69 already updated the `:96` finding literal)
- Rebuild: `dist/index.js`

**Interfaces:**
- Consumes: Tasks 69–70 fields on findings.
- Produces: rendered provenance on every surface (nothing downstream — terminal task).

**Exact behavior:**
- Inline trailer `` `src:<source> · conf <n>` `` (partials: source-only / confidence-only / none; `0` renders, never truthiness-tested); part of item text (inside `capBody`, never post-cap).
- Fallback rows `- Source:` / `- Confidence:` / `- Evidence:` after `- Message/evidence:` (present fields only).
- SARIF `properties` with present fields; omitted entirely when both absent.
- `survivor`: sources `"+"`-joined (collapse identical, re-cap 100); confidence max (absent iff all absent); evidence merged (first snippet, joined analyzer re-capped, absent iff none).
- README: provenance section (what each field means, 90/50/LLM values, display-only-no-gates statement, conf-50-on-high policy note).

- [ ] **Step 1: Write the failing tests**
  - Trailer units (full/partial/`conf 0`/neither) + inside-cap truncation case.
  - Fallback rows order + SARIF present/omitted + artifact round-trip.
  - Survivor provenance units (join/max/merge/absent rules) + cross-file pair stays ungrouped.
  - General-body item rendering with trailer.
  - F15 counts unchanged with provenance present + gate-equivalence (high+warning still gates identically).
  - No-LLM run (scanner provenance present, LLM fields absent) + agent run (absent everywhere).
  - readme sentences + evals cases summary Source-row update.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/review.test.ts tests/main.test.ts tests/readme.test.ts`
Expected: FAIL (no rendering).

- [ ] **Step 3: Implement**

Per Exact behavior + Interfaces. Gates untouched.

- [ ] **Step 4: Run tests + build**

Run: `npx vitest run tests/review.test.ts tests/main.test.ts tests/readme.test.ts && npx tsc --noEmit -p tsconfig.json && npm run build && node --check dist/index.js && npm run evals && npx vitest run`
Expected: PASS all green (evals after build); build clean.

- [ ] **Step 5: Commit**

```bash
git add src/review.ts src/main.ts README.md tests/review.test.ts tests/main.test.ts tests/readme.test.ts tests/fixtures/evals/cases.ts dist/index.js
git commit -m "feat: render finding provenance on every surface"
```
