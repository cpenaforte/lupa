# Q01 suggestion-patch validation — design spec

Date: 2026-10-13 | Status: draft (design approved: approach A) | Branch: `q01-suggestions`
Policy: `docs/superpowers/decisions/2026-10-12-q01-q04-policy.md` (Q01 section, binding)
Audit: `PROJECT_FINDINGS.md` Q01 (remediation prose rendered as applicable replacement)

## 1. Goal

Only an explicitly emitted replacement patch renders as an applicable GitHub
` ```suggestion ` fence. Everything else — explanatory prose, unmarked or
malformed suggestions — renders as advice text. Automatic application stays
out of scope. The audit's observed cases (credential-rotation prose fenced as
a suggestion, SQL prose fence, fixture prose fence) must render as advice;
genuine one-line replacements keep fencing.

## 2. Approach (approved)

Separate nullable `patch` field + target validation. The model emits
replacement code in a typed `patch` string exclusive to patches (the policy's
strict-marker condition, feasible: the schema already carries nullable
scalars across all providers — `duplicateOf`, `confidence` — through the
same `googleSchema` conversion). `suggestion` becomes advice-only prose.
Rendering fences **iff** a non-empty patch meets a valid RIGHT-side line
target (the policy's fallback validation, kept as the second gate). Rejected:
in-string marker (free-text convention fragility — the failure mode Q01
fixes); target-only validation (leaves prose-on-valid-lines fenced — the
audit's actual cases).

## 3. Interfaces

```ts
// fastpath.ts — contract addition (Finding home)
patch?: string; // replacement code for the flagged line; absent = no patch claim
// prompt.ts — schema addition (scalar, google-safe; same pattern as confidence)
patch: { type: ["string", "null"] } // + "patch" in item required + converted expectation
// llm.ts — toFindings carries patch (null/absent → absent; wrong type → whole response undefined, same as suggestion)
// review.ts — rendering split
export function hasPatch(f: Finding): f is Finding & { patch: string }; // trimmed-nonempty test on the stored value (stored verbatim, never trimmed)
export function formatBody(f: Finding, side: "LEFT" | "RIGHT", reopened?: boolean): string; // signature unchanged
// main.ts — isFinding accepts optional string patch; sanitizeFinding caps + control-strips it (SUGGESTION_CAP); redactFindings redacts it with the same keys
// review.ts — survivor: patch = first defined in member order, absent iff none (same precedent as evidence.snippet)
```

## 4. Exact behavior

- **Fence rule.** `formatBody(f, "RIGHT")` renders the applicable fence
  **iff** `hasPatch(f)` — fence content is `patch` (fence-length logic
  unchanged), never `suggestion`. `suggestion`, when present, always renders
  as `Suggested:` advice text — including on RIGHT hits (it no longer fences
  anywhere). No patch, empty patch, or whitespace-only patch → no fence,
  ever (trimmed test — a `"   "` patch is advice-shaped, not code).
- **Target rule (display side unchanged).** The `side` argument still comes
  from `mapToComments` RIGHT-then-LEFT resolution; only RIGHT-side hits are
  fence-eligible. A patch on a LEFT hit, general-body item, or fallback
  report renders as a plain fenced code block labeled advice-only (```,
  never ` ```suggestion `), followed by the `Suggested:` text when a
  suggestion exists. Trailer placement follows the Q04 rule (after any fence
  or `Suggested:` block, never inside).
- **Multiline allowed.** Patch content may span lines (GitHub replaces the
  flagged line with the block); no single-line enforcement in v1 (findings
  themselves stay single-line — `start_line`/`start_side` still never set).
- **Prompt.** One instruction sentence naming `patch` appended on the
  single-shot path next to the `DEDUP_INSTRUCTIONS`/`confidence` sentences
  (same gate — agent SYSTEM prompt byte-identical; agent mode gets the field
  through the shared schema/parser, and patch is content, not provenance, so
  `stripProvenance` leaves it alone).
- **Validation shapes.** `isFinding`: patch absent or string (else violation
  as today). `toFindings`: `patch: null`/absent → field absent; non-string
  non-null → whole response `undefined` (identical to the `suggestion`
  precedent — verdict-index alignment preserved by rejecting, never
  filtering). `sanitizeFinding`: cap via `capText` + `CONTROL_KEEP_TEXT`
  strip, same as suggestion. `redactFindings`: patch redacted with the same
  secret keys (replacement code can echo secrets).
- **Untouched.** Gates (`eventFor`/`exitFor`), Q02 partition/reopen identity
  (the reopen rule parser reads the `**sev** [rule]` head line — patch lives
  in the body, no parser impact), SARIF `message.text`, `findings.json`
  shape (new field rides along), F15 counts, `summaryFor`.
- **Fallback report.** New `- Proposed patch (advice only):` fenced row via
  the existing `field()` helper when patch is present (mirrors `- Source:` /
  `- Confidence:` / `- Evidence:` rows); the existing
  `- Suggested remediation (advice only):` row keeps rendering `suggestion`.

## 5. Tests

- Schema pins: `tests/prompt.test.ts:148` required list gains `"patch"`;
  `tests/adapters-google.test.ts` converted expectation gains the nullable
  string; `tests/probe-routing.test.ts` + `tests/adapters-routing.test.ts`
  single-shot pins; agent prompts byte-identical (no agent pin changes).
- `toFindings`: patch carried; `null`/absent → absent; wrong type →
  `undefined` (whole response); finding kept when patch absent but suggestion
  present.
- Rendering matrix (`tests/review.test.ts`): RIGHT+patch → fence with patch
  content + `Suggested:` advice; RIGHT+suggestion-only → advice, no fence
  (the audit regression pin); empty/whitespace patch → no fence; LEFT+patch
  → advice-only code block; general-body + fallback rows; trailer
  fence-external with patch present.
- Audit pins: credential-rotation prose and SQL-prose fixtures render as
  advice; one genuine replacement still fences.
- Sanitizer caps + control-strip; redaction of a secret inside patch on every
  surface shape; survivor first-patch-wins + absent-iff-none.
- Full suite + evals green; `failLevel` semantics unchanged (patch never gates).

## 6. Implementation split (plan preview)

Two sequential tasks: (i) contract + prompt/schema + toFindings + sanitizers
(`Finding.patch`, schema/required/converted/instruction,
`hasPatch`+`toFindings`, isFinding/sanitize/redact, pin updates); (ii)
rendering + survivor + fallback + docs (`formatBody` split, body/fallback
rows, survivor rule, README suggestion docs, audit pins, evals). Task (ii)
consumes (i)'s field; no parallel work.

## 7. Constraints and residuals

No new runtime dependencies, no new action inputs, stable namespace
(`pr-reviewer-*`, `lupa:` prefixes), no template/CI changes, `dist/`
committed per task, suite + evals green. Ships with the next release
vehicle — no tag alone. Accepted residuals: models may still put code in
`suggestion` (renders as advice — fail-safe direction); patch correctness
is never validated (applicability only, never auto-apply); multi-line
range targeting stays v1-out-of-scope.
