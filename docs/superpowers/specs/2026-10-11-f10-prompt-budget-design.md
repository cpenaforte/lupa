# Sub-project F10: complete inference-prompt budget — design

Date: 2026-10-12
Status: design approved (2026-10-12); review round 1 applied (2026-10-12)
Source: Codex audit `PROJECT_FINDINGS.md` (F10), local HEAD `885adea`
Goal: bound the whole single-shot inference request — fast findings, linked-issue
context, and diff together — with sanitized evidence, separate allowances, and
explicit omission records.

## Decisions (approved)

- Scope: F10 only (single-shot prompt path in `src/prompt.ts`, `src/main.ts`,
  `src/inputs.ts`, `action.yml`, README). The agent-mode initial assembly shares the
  same helper; tool-round accumulation stays F11. No adapter, scanner, template, or
  CI changes.
- Budget shape: new optional input `max_prompt_chars` (default 120,000 UTF-8 bytes).
  The existing `max_diff_chars` keeps its meaning (and its UTF-16 code-unit
  semantics) as the diff-only allowance inside the total; the README states the unit
  difference explicitly.
- Cut order when over budget: linked-issue context first, then fast-findings
  overflow (whole findings dropped with a count — never mid-finding cuts), then
  stop: the diff is never cut below its own cap. Every cut leaves an explicit
  marker/count.
- Sanitize-before-prompt: fast findings are sanitized once at Flow A construction,
  before both prompt assembly and artifact writes.
- Ship with the whole-plan release — no tag for F10 alone (standing instruction:
  release after the conclusion of the whole roadmap plan).

## 1. Problem

`buildMessages(fast, promptText, issueBody, skipped)` (`src/prompt.ts:39`) assembles
three unbounded regions — fast findings (full message text, no cap), linked-issue
body (whole issue text), and the diff (the only capped region, via `maxDiffChars` +
`PER_FILE_CAP`) — with no whole-request budget. A single 100,000-character TODO line
produces a ~108,000-character user message against a 60,000 diff cap. Worse,
`sanitizeFinding` runs after the LLM call (`src/main.ts:822`), so unsanitized
evidence (control characters, over-long fields) enters inference, and the early
artifact write (`:805`) persists it before the LLM call.

## 2. Design

### Units

All prompt budgeting is measured in UTF-8 bytes (`Buffer.byteLength` — what actually
ships). `max_diff_chars` stays in UTF-16 code units (`truncateDiff` compares
`section.length`); the two units are never compared directly. The diff floor is
computed dynamically, never from the raw settings: after assembly, the byte length
of the diff section alone exceeding the budget skips the slow path. Measurement
always happens on the final assembled string, so `neutralise()` expansion, the
skipped-files note, and section framing are accounted for automatically.

### New input

```yaml
# action.yml, beside max_diff_chars
max_prompt_chars:
  description: "Maximum UTF-8 bytes for the assembled single-shot LLM user message (diff + fast findings + linked-issue context, excluding the fixed system prompt). Requests that stay over budget after bounded cuts are skipped with a warning. Note: max_diff_chars is counted in UTF-16 code units, not bytes."
  required: false
  default: "120000"
```

`ActionInputs.maxPromptChars: number` (required, like `maxDiffChars`) via
`readInt("max_prompt_chars", 120000, 1)`. README documents it beside
`max_diff_chars` with the unit note. The three typed `ActionInputs` literals
(`tests/main.test.ts:173`, `tests/evals/harness.ts:32`,
`tests/evals-live/live-manual.test.ts:45`) gain the field — listed as plan change
sites. Budget covers the user message only; the fixed system prompt (~2 KB) is
excluded by design (stated, not counted).

### Budget enforcement

New `budgetPrompt()` in `src/main.ts` (tests live in `tests/main.test.ts`, which
already imports it):

```ts
budgetPrompt(
  fast: Finding[],
  promptText: string,
  issueBody: string | undefined,
  skipped: string[],
  budget: number,
): { fast: Finding[]; issueBody: string | undefined; skipped: string[]; findingsOmitted: number }
```

It takes the same structured regions `buildMessages` renders (never string surgery
on the assembled message — `buildMessages` stays pure and signature-stable), applies
the cuts below, and the caller re-renders via the unchanged `buildMessages`, then
appends the omission prose line when `findingsOmitted > 0`:

```
Omitted <M> fast finding(s) to fit the prompt budget.
```

(a prose line after the findings array, mirroring the existing `## Diff budget note`
pattern — the findings JSON stays homogeneous). Both the single-shot (`:530`) and
agent-mode (`:576`) assembly sites share the helper for the initial message; agent
tool-round accumulation is F11 and out of scope (no agent-path budget test).

Cut order, each leaving its explicit record:

1. **Linked-issue context**: byte-truncate the neutralised issue text with a
   trailing `…[issue context truncated to fit the prompt budget]` marker, keeping
   the `<linked-issue>` tags balanced (marker inside the block). The cut is
   code-point-safe (surrogate-safe, reusing the existing cut helper approach).
2. **Fast findings**: drop whole findings from the tail until in budget, counting
   them in `findingsOmitted`. Never mid-finding truncation — the JSON stays
   parseable. Order is positional (pipeline order: deterministic L0/scanner evidence
   first, toolchain L2 last — no severity reordering, no policy change).
3. **Diff**: never cut below its own contract. If the diff section alone exceeds the
   budget, or anything remains over budget after (1)+(2), the slow path skips with
   a warning naming both sizes
   (`prompt <bytes> exceeds max_prompt_chars <budget> after bounded cuts`).

The cut affects model context only: posting and artifacts use the full `fast`
array (`all` at `:822`), so omitted findings still reach the review.

### Skipped-files note

`buildMessages` caps the rendered skipped-file list at 20 entries with an
`…and <N> more omitted from this note` line (pure function, still pure; existing
tests use fewer). The note is inside the measured string, so it is budgeted
automatically.

### Sanitize-before-prompt

The `fast` array is mapped through the existing `sanitizeFinding` once at Flow A
construction (`src/main.ts:803`: `const fast = [...l0, ...scan.findings, ...l2].map(sanitizeFinding)`).
Prompt and both artifact writes (`:805` early, `:822` merged — re-sanitizing is
idempotent) then share identical pre-sanitized evidence. The deterministic eval
fixtures carry clean synthetic data (no control characters, short fields, safe
paths), which `sanitizeFinding` passes through unchanged — the eval suite staying
green proves the identity on fixtures (required verification). `redactFindings`
ordering (F02) is untouched, and the prompt path stays unredacted (pre-existing;
stated explicitly, out of scope).

## 3. Tests

`tests/prompt.test.ts` (pure assembler — unchanged) plus `tests/main.test.ts`
`describe("prompt budget")` (TDD; small `maxPromptChars` overrides, e.g. 2000, so
fixtures stay small — one 4,000-character TODO line no longer suffices since
`MSG_CAP` bounds each finding and the overflow needs many findings or a small budget):

- Oversized issue body truncates with the marker; tags stay balanced; rest intact.
- Fast-findings overflow drops whole tail findings with an exact omitted count rendered
  as the prose line; the surviving JSON parses.
- Diff is never cut below `maxDiffChars` (over-budget fixture with maxed diff →
  slow-path skip, not a cut diff).
- Still-over-budget-after-cuts skips with the size-naming warning; no LLM call.
- Control characters / over-long fields in fast findings are stripped/capped in the
  captured prompt (pre-LLM sanitization).
- `ActionInputs` fixture updates (`tests/main.test.ts:173`, `tests/evals/harness.ts:32`,
  `tests/evals-live/live-manual.test.ts:45` — the last is untracked throwaway; update
  only if touched).
- Default 120,000 leaves all existing suite fixtures untouched; full eval suite green
  (sanitize identity on fixtures).

## 4. Verification and release

- Gates: focused main tests, full `vitest` + evals, `tsc --noEmit`,
  `npm run build && node --check dist/index.js`, committed `dist/`.
- No canary (prompt shaping is fixture-pinned; live-model wording is out of scope);
  no tag — ships with the whole-plan release.

## Out of scope

F11 (agent/whole-review deadlines and tool-round accumulation — only the initial
single-shot assembly is budgeted here), F15 (aggregate output limits), Q01–Q04,
F14, template/CI changes, other new inputs or dependencies, touching
`buildMessages`' assembly contract, redacting the prompt path.
