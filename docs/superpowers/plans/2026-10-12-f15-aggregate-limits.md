# F15 aggregate output limits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound every aggregate input and publication surface with tested limits and visible outcomes at each bound.

**Architecture:** Task 62 adds the four inputs; Task 63 gates ingestion (capped reads, fail-loud oversize); Task 64 funnels publication (prioritize → top-N → inline fold → char cap → fold re-cap). Sequential (62 → 63 → 64); 63 and 64 both touch `src/main.ts` in disjoint regions. (Roadmap Task 49 is the F15 *stage*; implementation Tasks 62–64 below are its execution units.)

**Tech Stack:** TypeScript 5.x, Node >=24, vitest, esbuild (`dist/` committed).

**Spec:** `docs/superpowers/specs/2026-10-12-f15-aggregate-limits-design.md`

## Global Constraints

- No new runtime dependencies (node builtins + existing deps only). No template or CI changes (`action.yml` + README + `src/inputs.ts` ARE in scope — inputs are not templates).
- `PR_REVIEWER_*` env names, `pr-reviewer-*` strings, `pr-reviewer/1.0` user-agent, SARIF driver name, `lupa:` log prefixes unchanged.
- Every task ends with `npx tsc --noEmit -p tsconfig.json`, `npm run build && node --check dist/index.js` and commits `dist/index.js`.
- Full suite (`npx vitest run`) + evals (`npm run evals`) green before every task commit.
- Commit messages use the exact strings given per task.
- Ships with the whole-plan release — no tag for F15 alone.

## Review Focus

- **A 422 off-diff fold on a full-caps body keeps the omission count and ends under the cap with exactly one trunc-note.** Test in Task 64's step style (folded + recapped fixture).
- **An oversized gitleaks report with exit 0 reads as degraded, never clean.** Test in Task 63's step style (valid-but-oversize SARIF file → zero findings + exact warning).
- **A 10 MB `findings.json` in Flow B throws loudly and posts nothing.** Test in Task 63's step style.
- **`max_review_body_chars: 5` is rejected before any work.** Test in Task 62's step style.
- **A summary near 1 MiB with pre-existing notes still posts the review.** Test in Task 64's step style (capped summary + warn-and-skip path).

---

### Task 62: F15 — aggregate-limit inputs

**Files:**
- Modify: `action.yml` (4 inputs), `src/inputs.ts` (fields + parsing), `README.md` (docs)
- Test: `tests/inputs.test.ts` (names/defaults/rejections), `tests/readme.test.ts` (extend agent-inputs case), `tests/main.test.ts` (`inputsFor` + `MockOpts` only)
- Rebuild: `dist/index.js`

**Interfaces:**
- Consumes: existing `readInt(name, fallback, min)` + `Invalid ${name}` shape.
- Produces: `ActionInputs` fields `maxFindings: number`, `maxInlineComments: number`, `maxReviewBodyChars: number`, `maxArtifactBytes: number`; `export const DEFAULT_MAX_ARTIFACT_BYTES = 8388608` (shared fallback; scanners use it as a default without importing input plumbing).

**Exact behavior:**
- `action.yml`: `max_findings` default 200, `max_inline_comments` default 30, `max_review_body_chars` default 60000, `max_artifact_bytes` default 8388608 (descriptions per spec §2).
- `getInputs`: `maxFindings: readInt("max_findings", 200, 1)`, `maxInlineComments: readInt("max_inline_comments", 30, 1)`, `maxReviewBodyChars: readInt("max_review_body_chars", 60000, 1000)`, `maxArtifactBytes: readInt("max_artifact_bytes", DEFAULT_MAX_ARTIFACT_BYTES, 1)`.
- `tests/main.test.ts` `inputsFor` gains `maxFindings: o.maxFindings ?? 200` (same pattern for all four) + matching `MockOpts` optional fields (pattern follows `maxPromptChars`).

- [ ] **Step 1: Write the failing tests**
  - `tests/inputs.test.ts`: extend the input-name list with the four snake_case names; defaults test (`maxFindings` 200, `maxInlineComments` 30, `maxReviewBodyChars` 60000, `maxArtifactBytes` 8388608); rejections (`max_findings: "0"`, `max_review_body_chars: "5"`, `"12.5"`, `"lots"` → throw naming the input).
  - `tests/readme.test.ts`: extend the agent-inputs case with the four names.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/inputs.test.ts tests/readme.test.ts`
Expected: FAIL (unknown inputs).

- [ ] **Step 3: Implement in `action.yml` + `src/inputs.ts` + `README.md` + test `inputsFor`/`MockOpts`**

Per Exact behavior. Touch nothing else.

- [ ] **Step 4: Run tests + build**

Run: `npx vitest run tests/inputs.test.ts tests/readme.test.ts tests/main.test.ts && npx vitest run && npm run evals && npx tsc --noEmit -p tsconfig.json && npm run build && node --check dist/index.js`
Expected: PASS all green; build clean.

- [ ] **Step 5: Commit**

```bash
git add action.yml src/inputs.ts README.md tests/inputs.test.ts tests/readme.test.ts tests/main.test.ts dist/index.js
git commit -m "feat: aggregate-limit inputs for F15 bounds"
```

---

### Task 63: F15 — ingestion gate

**Files:**
- Create: `src/artifact-limits.ts` (capped read + oversize policy)
- Modify: `src/scanners.ts` (`runScanners`/`fromStdout`/`runGitleaks`/SBOM branch), `src/main.ts` (`readFindings` only), `src/diff.ts` (`readPrMeta` only)
- Test: `tests/artifact-limits.test.ts` (new), `tests/scanners.test.ts`, `tests/main.test.ts` (readFindings), `tests/diff.test.ts` (readPrMeta)
- Rebuild: `dist/index.js`

**Interfaces:**
- Consumes: Task 62's `DEFAULT_MAX_ARTIFACT_BYTES` + `ActionInputs.maxArtifactBytes` (threaded as plain numbers — no input plumbing imports in scanners).
- Produces: `readCappedFile(path, maxBytes): Promise<{ ok: true; text: string } | { ok: false; oversize: true }>` (explicit-length read of at most `max+1` bytes); `oversizeWarning(source: string, max: number): Finding` (exact spec text); `fromStdout` gains trailing `maxBytes: number = DEFAULT_MAX_ARTIFACT_BYTES`; `runScanners` options gain `maxArtifactBytes?: number`; `runGitleaks(dir, timeoutMs, maxBytes?)`; `readFindings(dir, maxBytes)`; `readPrMeta` capped identically.

**Exact behavior:**
- `readCappedFile`: oversize (bytesRead > max) returns `{ ok: false, oversize: true }` without ever holding the file; read errors propagate to the caller's existing handling (NOT conflated with oversize).
- `fromStdout`: `Buffer.byteLength(r.stdout) > max` → `[oversizeWarning(label, max)]` FIRST (label = the existing `label` arg: `semgrep`, `trivy`, `` `osv-scanner (${lock})` ``); no parse attempted. SBOM branch: same check before `isCycloneDx`, source `"sbom"`.
- `runGitleaks`: capped file read; oversize → `[oversizeWarning("gitleaks", max)]` on a DISTINCT branch before the exit-code check (an exit-0 oversize reads as degraded, never `[]`).
- `readFindings`: oversize → throw `lupa: findings.json exceeds the artifact read limit (${max} bytes)` (exact). `readPrMeta`: oversize → throw in the existing `Invalid pr-meta.json …` shape.
- `runScanners` threads `o.maxArtifactBytes` into every `fromStdout` call, `runGitleaks`, and the SBOM check; `main.ts:877` passes `env.inputs.maxArtifactBytes`. `diff.patch` reads explicitly untouched.

- [ ] **Step 1: Write the failing tests**
  - `tests/artifact-limits.test.ts`: `readCappedFile` exact-max passes / max+1 oversize / missing file propagates (rejects); `oversizeWarning` exact text.
  - `tests/scanners.test.ts`: valid-but-oversize SARIF stdout (small `maxBytes` via constructed args) → zero findings + exact warning; gitleaks-shaped oversize file with exit 0 → warning, not `[]`.
  - `tests/main.test.ts`: oversized `findings.json` → exact throw. `tests/diff.test.ts`: oversized `pr-meta.json` → `Invalid pr-meta.json` throw.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/artifact-limits.test.ts tests/scanners.test.ts tests/main.test.ts tests/diff.test.ts`
Expected: FAIL (no caps).

- [ ] **Step 3: Implement**

Per Exact behavior + Interfaces. Touch nothing else in these files.

- [ ] **Step 4: Run tests + build**

Run: `npx vitest run tests/artifact-limits.test.ts tests/scanners.test.ts tests/main.test.ts tests/diff.test.ts && npx vitest run && npm run evals && npx tsc --noEmit -p tsconfig.json && npm run build && node --check dist/index.js`
Expected: PASS all green; build clean.

- [ ] **Step 5: Commit**

```bash
git add src/artifact-limits.ts src/scanners.ts src/main.ts src/diff.ts tests/artifact-limits.test.ts tests/scanners.test.ts tests/main.test.ts tests/diff.test.ts dist/index.js
git commit -m "fix: bounded artifact ingestion with fail-loud oversize (F15)"
```

---

### Task 64: F15 — publication funnel

**Files:**
- Modify: `src/review.ts` (`prioritizeFindings`, `capBody`), `src/main.ts` (`publishReview` funnel, dry-run log, summary write, issue-fallback site, `Gateway.createReview` opts + call site), `src/github.ts` (`PostReviewOptions.maxBodyChars` required + fold re-cap)
- Test: `tests/review.test.ts`, `tests/main.test.ts`, `tests/github.test.ts` (fakes gain `maxBodyChars`; existing no-opts `postReview` calls compile unchanged)
- Rebuild: `dist/index.js`

**Interfaces:**
- Consumes: Task 62's field names (`env.inputs.maxFindings/maxInlineComments/maxReviewBodyChars`); Task 63's capped reads (already bounded inputs — no code dependency).
- Produces: `prioritizeFindings(findings: Finding[]): Finding[]` (severity rank high/warning/info, stable); `capBody(body: string, maxChars: number, markers: string[]): string` (markers guaranteed inside cap; whole-line cuts; mid-line code-point-safe fallback; unclosed-fence backup; trunc-note template strip).

**Exact behavior:**
- `publishReview`: `ordered = prioritizeFindings(findings)` → `retained`/`omitted`; `mapToComments(retained, hunks)` → inline sliced to `maxInlineComments`, excess appended to general; `body = buildBody(general, summaryFor(fullSet))`; `capBody(body, maxReviewBodyChars, omitted>0 ? [omissionMarker] : [])`; `RangeError` iff markers alone exceed the cap; dry-run log gains posted counts + `omitted=`; `eventFor`/`exitFor` call sites unchanged (full pre-cap set); summary write via `buildFallbackReport(findings, { maxBytes: 1048576 − existing − 1 })`, too-small → `core.warning` + skip.
- `postReview`: fold path extracts `> Omitted:` lines as `capBody` markers, strips stale trunc-notes (template regex), re-caps with `opts.maxBodyChars`, fresh trunc-note last.
- `Gateway.createReview` opts gain required `maxBodyChars: number`; `realGateway` forwards it; `main.ts:774` passes `env.inputs.maxReviewBodyChars`.
- Issue-fallback site: `buildFallbackReport(retained, { maxBytes: maxReviewBodyChars − markerBytes − 2 })` with the publication omission marker prepended when `omitted > 0`.

- [ ] **Step 1: Write the failing tests**
  - `tests/review.test.ts`: `prioritizeFindings` order (highs, stable ties) + `capBody` units (whole-line, over-long mid-line cut, emoji-safe, fence backup, stale-note strip, marker-inside guarantee, marker-too-big `RangeError`).
  - `tests/main.test.ts`: 500-finding funnel (retained 200, inline 30, folded general order, exact `> Omitted: 300` marker, gates see 500, artifact keeps 500); body truncation (note inside cap); summary cap + skip-warning; dry-run `omitted=`; issue-fallback retained-set body.
  - `tests/github.test.ts`: off-diff fold re-cap (single trunc-note last, omission count preserved, under cap).
  - Flow B bounds: end-to-end through the shared paths (capped `readFindings` + capped `publishReview`); oversized Flow B artifact → loud throw with nothing posted.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/review.test.ts tests/main.test.ts tests/github.test.ts`
Expected: FAIL (no funnel).

- [ ] **Step 3: Implement**

Per Exact behavior + Interfaces. `mapToComments`/`buildBody`/`buildFallbackReport` bodies unchanged (composed, not modified). Touch nothing else.

- [ ] **Step 4: Run tests + build**

Run: `npx vitest run tests/review.test.ts tests/main.test.ts tests/github.test.ts && npx vitest run && npm run evals && npx tsc --noEmit -p tsconfig.json && npm run build && node --check dist/index.js`
Expected: PASS all green; build clean.

- [ ] **Step 5: Commit**

```bash
git add src/review.ts src/main.ts src/github.ts tests/review.test.ts tests/main.test.ts tests/github.test.ts dist/index.js
git commit -m "fix: bounded publication with visible omissions (F15)"
```
