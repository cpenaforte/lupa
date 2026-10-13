# Q03 heuristic evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Heuristic-only findings without direct secret evidence stop being emitted; evidence-backed ones keep flagging.

**Architecture:** Task 76 gates `sensitive-path` on deletions + added-line content evidence (new pure helpers, pin rework for flipped fixtures). Task 77 makes TODO add-only, reworks the remaining pins, adds the evals pair, and updates the README note. Sequential (76 → 77). (Out-of-queue follow-up after dedup → Q04 → Q02 → Q01.)

**Tech Stack:** TypeScript 5.x, Node >=24, vitest, esbuild (`dist/` committed).

**Spec:** `docs/superpowers/specs/2026-10-13-q03-heuristics-design.md`

## Global Constraints

- No new runtime dependencies, no new action inputs, no template or CI changes.
- `PR_REVIEWER_*` env names, `pr-reviewer-*` strings, `pr-reviewer/1.0` user-agent, SARIF driver name, `lupa:` log prefixes unchanged.
- Every task ends with `npx tsc --noEmit -p tsconfig.json`, `npm run build && node --check dist/index.js` and commits `dist/index.js`.
- Full suite (`npx vitest run`) + evals (`npm run evals`) green before every task commit (evals after build).
- Commit messages use the exact strings given per task.
- Ships with the next release vehicle — no tag alone.

## Review Focus

- **A deleted `id_rsa` emits nothing on any rule.** Test in Task 76's step style (deleted entry → zero findings).
- **`PORT=3000` stays silent while `DB_PASS=hunter2` flags.** Test in Task 76's step style (same `.env` matrix).
- **A CRLF `.env` parses and its placeholders match.** Test in Task 76's step style (`\r` inputs).
- **A context-line TODO goes silent while added-line numbering is unchanged.** Test in Task 77's step style (`:117-120` → `[]`, `:113-114` keeps `[41]`).
- **A cert-only addition stays silent end-to-end while a key addition blocks.** Test in Task 77's step style (evals pair).

---

### Task 76: Q03 — deletion skip, content evidence, sensitive-path gating

**Files:**
- Modify: `src/fastpath.ts` (`deleted` continue-all, `contentText`, `addedLines`, `hasPrivateKeyMarker`, `isPlaceholderValue`, `isSecretKeyName`, `isSecretValue`, `sensitive-path` rewrite; `isSensitivePath`/`ENV_TEMPLATES`/message unchanged), `tests/main.test.ts` (`:1257` fixture gains PEM content + silence variant)
- Test: `tests/fastpath.test.ts` (helper units, emission matrix, reworked `:20`, `:76-84`, `:87+`)
- Rebuild: `dist/index.js`

**Interfaces:**
- Consumes: `FileDiff.deleted` (Q02), `capText`/`TRUNC_MARK` untouched.
- Produces: `contentText(raw)` (CR-strip, shared classifier); `addedLines(hunks)`; `hasPrivateKeyMarker(lines)`; `isPlaceholderValue(rawValue)` (owns comment/quote/trim pipeline); `isSecretKeyName(key)` (substring list OR delimited PASS/SIGNING/ENCRYPTION/MASTER/AUTH/AUTHORIZATION segments); `isSecretValue(rawValue)` (non-placeholder AND non-numeric/boolean/bare-URL) — plan-level split of the spec §4 key/value rules (spec §5 units require testable units). `todoMarkers` untouched (Task 77) — `:117-120` keeps passing here.

**Exact behavior:**
- `runL0` loop top: `if (f.deleted === true) continue;` (all rules).
- Sensitive-path emits iff file non-deleted, `isSensitivePath`, AND (`hasPrivateKeyMarker(addedLines)` OR (sensitive is `.env`-family AND some added assignment has `isSecretKeyName(key)` AND `isSecretValue(value)`)). Message/`high`/`source`/`confidence` unchanged.
- `isSecretValue`: `isPlaceholderValue` false AND not numeric `/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/`, not boolean `/^(true|false|yes|no|on|off)$/i`, not credential-less URL (scheme `://`, no `@` before first `/`). Comment-only values (`# fill in`) strip to empty → placeholder → silent.
- Pin rework (gates stay green THIS task): `:20` id_rsa gains PEM content; `:76-84` content-bearing + hunk-less silence trio; `:87+` `.env.local` gains secret-keyed real assignment; `:1257` SENSITIVE_DIFF gains a PEM marker line (blocking path kept) + new silence variant (marker-less content → COMMENT + exit 0, no item).
- Deviation from spec §6 preview (stated): `:1257` moves to Task 76 — the task that flips its behavior owns its pins (per-task green requirement). Task 77 keeps `:117-120`, evals, README.

- [ ] **Step 1: Write the failing tests**
  - Helpers: marker variants + cert-only/PUBLIC-KEY negatives; placeholder literals/patterns/`$VAR` vs `$HOME/real`/quotes/`# fill in`; key segments (`DB_PASS`, `SIGNING`, `COMPASS`); value shapes (numeric/boolean/bare-URL/userinfo-URL); CRLF trio.
  - Matrix: deleted → nothing; cert-only → nothing; key `.pem`/`id_rsa` → high; placeholder `.env` → nothing; `PORT`/`DEBUG` → nothing; `DB_PASS=hunter2` → high; empty/binary/hunk-less → nothing; `export`/quotes/comments.
  - Reworked pins as above + `:1257` blocking-kept + silence variant.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/fastpath.test.ts tests/main.test.ts`
Expected: FAIL (no content gating).

- [ ] **Step 3: Implement**

Per Exact behavior + Interfaces. `todoMarkers`, gates, SARIF/artifact untouched.

- [ ] **Step 4: Run tests + build**

Run: `npx vitest run tests/fastpath.test.ts tests/main.test.ts && npx tsc --noEmit -p tsconfig.json && npm run build && node --check dist/index.js && npm run evals && npx vitest run`
Expected: PASS all green (evals after build); build clean.

- [ ] **Step 5: Commit**

```bash
git add src/fastpath.ts tests/fastpath.test.ts tests/main.test.ts dist/index.js
git commit -m "feat: gate sensitive-path on added-line secret evidence"
```

---

### Task 77: Q03 — add-only TODO, evals pair, README note

**Files:**
- Modify: `src/fastpath.ts` (`todoMarkers` scan-predicate only — counting byte-identical), `tests/fastpath.test.ts` (`:117-120` → `[]`), `tests/fixtures/evals/cases.ts` + 2 fixtures, `README.md` (note reword)
- Test: `tests/fastpath.test.ts`, `tests/readme.test.ts` (new pin phrase from the note), evals bundle (`cases.ts` + 2 fixtures)
- Rebuild: `dist/index.js`

**Interfaces:**
- Consumes: Task 76's `contentText` + helpers (no changes to them).
- Produces: add-only TODO; evals pair; README note (nothing downstream — terminal task).

**Exact behavior:**
- `todoMarkers`: TODO-test applies only when `contentText(raw)` is defined; `@@` never advances; `" "`/empty advance exactly as today; `-`/`\` skipped. Only the predicate changes.
- `:117-120` asserts `[]`; `:113-114` keeps `[41]` (already pinned — verifies counting untouched).
- Evals fixtures `q03-key-addition.patch` (new `id_rsa` + `-----BEGIN RSA PRIVATE KEY-----` → lineless high → general-body `**blocking**` item, REQUEST_CHANGES + exit 1 at `fail_level: high`) + `q03-cert-addition.patch` (new `certs/public.pem` cert-only → zero findings, clean body, exit 0); follow the `positive-authz` case shape for bodies/payloads.
- README: reword the `:170` note to the content-gated rule; keep `confidence: 50`; add one `readme.test` pin phrase taken from the new note.
- Gates, SARIF/artifact/F15 mechanics untouched (counts shrink by construction).

- [ ] **Step 1: Write the failing tests**
  - `:117-120` → `[]`; header-with-marker-context (`@@ ... TODO ...`) → nothing; added TODO keeps number; `readme.test` new phrase.
  - Evals pair with exact bodies/exits per Exact behavior.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/fastpath.test.ts tests/readme.test.ts`
Expected: FAIL (context TODOs still emit).

- [ ] **Step 3: Implement**

Per Exact behavior + Interfaces.

- [ ] **Step 4: Run tests + build**

Run: `npx vitest run tests/fastpath.test.ts tests/readme.test.ts && npx tsc --noEmit -p tsconfig.json && npm run build && node --check dist/index.js && npm run evals && npx vitest run`
Expected: PASS all green (evals after build); build clean.

- [ ] **Step 5: Commit**

```bash
git add src/fastpath.ts tests/fastpath.test.ts tests/fixtures/evals/cases.ts tests/fixtures/evals/q03-key-addition.patch tests/fixtures/evals/q03-cert-addition.patch README.md tests/readme.test.ts dist/index.js
git commit -m "feat: add-only TODO markers, Q03 evals pair, heuristic docs"
```
