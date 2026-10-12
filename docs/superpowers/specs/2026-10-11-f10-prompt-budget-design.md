# Sub-project F10: complete inference-prompt budget — design

Date: 2026-10-12
Status: design approved (2026-10-12)
Source: Codex audit `PROJECT_FINDINGS.md` (F10), local HEAD `885adea`
Goal: bound the whole single-shot inference request — fast findings, linked-issue
context, and diff together — with sanitized evidence, separate allowances, and
explicit omission records.

## Decisions (approved)

- Scope: F10 only (single-shot prompt path in `src/prompt.ts`, `src/main.ts`,
  `src/inputs.ts`, `action.yml`, README). Agent-mode prompt assembly shares the
  same budget path. No adapter, scanner, template, or CI changes.
- Budget shape: new optional input `max_prompt_chars` (default 120,000). The
  existing `max_diff_chars` keeps its meaning as the diff-only allowance inside
  the total.
- Cut order when over budget: linked-issue context first, then fast-findings
  overflow (whole findings dropped with a count — never mid-finding cuts), then
  stop: the diff is never cut below its own cap. Every cut leaves an explicit
  marker/count.
- Sanitize-before-prompt: fast findings pass through the existing
  `sanitizeFinding` field caps + control-strip before `buildMessages`.
- Ship with the whole-plan release — no tag for F10 alone (standing instruction:
  release after the conclusion of the whole roadmap plan).

## 1. Problem

`buildMessages(fast, promptText, issueBody, skipped)` (`src/prompt.ts:39`) assembles
three unbounded regions — fast findings (full message text, no cap), linked-issue
body (whole issue text), and the diff (the only capped region, via `maxDiffChars` +
`PER_FILE_CAP`) — with no whole-request budget. A single 100,000-character TODO line
produces a ~108,000-character user message against a 60,000 diff cap. Worse,
`sanitizeFinding` runs after the LLM call (`src/main.ts:822`), so unsanitized
evidence (control characters, over-long fields) enters inference.

## 2. Design

### New input

```yaml
# action.yml, beside max_diff_chars
max_prompt_chars:
  description: "Maximum UTF-8 bytes for the assembled single-shot LLM user message (diff + fast findings + linked-issue context). Requests that stay over budget after bounded cuts are skipped with a warning."
  required: false
  default: "120000"
```

`ActionInputs.maxPromptChars: number` via `readInt("max_prompt_chars", 120000, 1)`.
README documents it beside `max_diff_chars`. Misconfiguration (`maxPromptChars`
below the diff floor, i.e. below `maxDiffChars` + fixed framing) warns once at
startup and behaves as budget-exhausted (slow path skips — never sends silently).

### Budget enforcement

New `budgetPrompt()` in `src/main.ts`, applied to the assembled user message
between `buildMessages` and the slow-path call (both single-shot `:530` and
agent-mode `:576` assembly paths share it). `buildMessages` stays a pure assembler
(existing `tests/prompt.test.ts` untouched). Measurement in UTF-8 bytes
(`Buffer.byteLength`, what actually ships).

Cut order, each leaving its explicit record in the prompt:

1. **Linked-issue context**: byte-truncate the neutralised issue text with a
   trailing `…[issue context truncated to fit the prompt budget]` marker, keeping
   the `<linked-issue>` tags balanced (marker inside the block).
2. **Fast findings**: drop whole findings from the tail of the JSON array until in
   budget, then append a sibling record `{"omitted_findings": M}` (M > 0 only).
   Never mid-finding truncation — the JSON stays parseable.
3. **Diff**: never cut below its own contract (`maxDiffChars` + `PER_FILE_CAP`).
   If still over budget after (1)+(2), the slow path skips with a warning naming
   both sizes (`prompt <bytes> exceeds max_prompt_chars <budget> after bounded cuts`).

### Sanitize-before-prompt

The `fast` array passed to `buildMessages` is mapped through the existing
`sanitizeFinding` (control-strip + `MSG_CAP`/`RULE_CAP`/`FILE_CAP`/`SUGGESTION_CAP`)
at the Flow A assembly site. Prompt and artifacts then share identical
pre-sanitized evidence; the artifact write at `:822` is behaviorally unchanged
(sanitizing twice is idempotent). `redactFindings` ordering (F02) is untouched.

## 3. Tests

`tests/prompt.test.ts` (pure assembler — unchanged) plus new budget tests
(colocated `tests/prompt.test.ts` `describe("budgetPrompt")` or `tests/main.test.ts`
fixtures, TDD):

- Oversized issue body truncates with the marker; tags stay balanced; rest intact.
- Fast-findings overflow drops whole tail findings with an exact omitted count; the
  surviving JSON parses.
- Diff is never cut below `maxDiffChars` (over-budget fixture with maxed diff →
  slow-path skip, not a cut diff).
- Still-over-budget-after-cuts skips with the size-naming warning; no LLM call.
- Control characters / over-long fields in fast findings are stripped/capped in the
  captured prompt (pre-LLM sanitization).
- Default 120,000 leaves all existing fixtures untouched (no existing test changes).

## 4. Verification and release

- Gates: focused prompt/main tests, full `vitest`, `tsc --noEmit`,
  `npm run build && node --check dist/index.js`, committed `dist/`.
- No canary (prompt shaping is fixture-pinned; live-model wording is out of scope);
  no tag — ships with the whole-plan release.

## Out of scope

F11 (agent/whole-review deadlines — only the single-shot path is budgeted here;
agent tool rounds keep their own budgets), F15 (aggregate output limits),
Q01–Q04, F14, template/CI changes, other new inputs or dependencies, touching
`buildMessages`' assembly contract.
