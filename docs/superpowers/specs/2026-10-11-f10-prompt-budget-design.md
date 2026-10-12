# Sub-project F10: complete inference-prompt budget — design

Date: 2026-10-12
Status: design approved (2026-10-12); review rounds 1-8 applied, round 9 pending
Source: Codex audit `PROJECT_FINDINGS.md` (F10), local HEAD `885adea`
Goal: bound the variable user-message portion of the single-shot inference request — fast findings, linked-issue
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
- Non-ASCII-heavy PRs may skip at default config (60,000 UTF-16 units of CJK ≈
  180,000 bytes > the 120,000-byte default): accepted as intended — the budget is a
  cost/surprise control, the skip warns with both sizes, and the knob is tunable.
  README states this plainly.
- Sanitize-before-prompt: fast findings are sanitized once at Flow A construction,
  before both prompt assembly and artifact writes.
- Ship with the whole-plan release — no tag for F10 alone (standing instruction:
  release after the conclusion of the whole roadmap plan).

## 1. Problem

`buildMessages(fast, promptText, issueBody, skipped)` (`src/prompt.ts:39`) assembles
three unbounded regions — fast findings (full message text, no cap), linked-issue
body (whole issue text), and the diff (the only capped region, via `maxDiffChars` +
`PER_FILE_CAP`) — with no whole-request budget. A single 100,000-character TODO line
produces an 8,000-character truncated diff excerpt (the `PER_FILE_CAP` cut), yet a
~108,000-character user message — the finding repeats the full 100,000-character line
outside any cap. Worse,
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
  description: "Maximum UTF-8 bytes for the assembled initial LLM user message on both paths (single-shot reviews and the agent-mode initial message): diff text, fast-findings JSON, linked-issue context, section headers, and the skipped-files note (the fixed ~1.5 KB system prompt is excluded). Requests that stay over budget after bounded cuts are skipped with a warning. Note: max_diff_chars is counted in UTF-16 code units, not bytes."
  required: false
  default: "120000"
```

`ActionInputs.maxPromptChars: number` (required, like `maxDiffChars`) via
`readInt("max_prompt_chars", 120000, 1)`. README documents it beside
`max_diff_chars` with the unit note, and the Cost ceiling bullet is updated: the spend
bound is now `max_prompt_chars` — 120,000 bytes ≈ 30k input tokens (≈bytes/4) plus prompt
overhead, roughly $0.30 to $0.60 at the same frontier-model rates (keeping the pinned
"about 3k input and 600 output tokens" comparison sentence — `tests/readme.test.ts:50`
pins it). The two typed `ActionInputs` literals in the
tracked suite (`tests/main.test.ts:173`, `tests/evals/harness.ts:32`) gain the field —
listed as plan change sites. Budget covers the user message only; the fixed system
prompt (~1.5 KB, plus ~480 B agent addendum on that path) is excluded by design
(stated, not counted).

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
): { fast: Finding[]; issueBody: string | undefined; skipped: string[]; findingsOmitted: number; issueDropped: boolean }
```

It takes the same structured regions `buildMessages` renders (never string surgery
on the assembled message). `buildMessages` gains one optional parameter after the
existing `agent?` slot — `buildMessages(fast, promptText, issueBody, skipped, agent, omitted = 0)` —
rendering the prose line after the findings JSON when > 0 (single-shot callers pass
`undefined` for `agent`: `buildMessages(fast, promptText, issueBody, skipped, undefined, omitted)`).
Still a pure function; existing 4- and 5-arg callers and tests are unaffected. There is
exactly ONE budgeted assembly: `budgetPrompt` + `buildMessages` run once before the
`if (i.llmAgent)` branch with the full 6-arg call
`buildMessages(b.fast, promptText, b.issueBody, b.skipped, i.llmAgent ? { maxTurns: i.llmAgentMaxTurns } : undefined, b.findingsOmitted)`,
and both paths consume its outputs (the agent path adds
tools/turns around the same message). The caller algorithm is fixed (no invention): render via the 6-arg call, measure `bytes = Buffer.byteLength(m.user, "utf8")`, and skip with the size-naming warning when over budget. No separate diff-bytes term: a diff that alone exceeds the budget makes the total exceed it, so one total check subsumes both branches (the fixtures still distinguish them). Add one agent-path test asserting the rendered agent user message contains the omission line when findings are omitted (a 6th-arg wiring test with a small `maxPromptChars` fixture forcing the cut — the `Tool budget` addendum lives in `system` and is unaffected by construction; this does not test cut/skip behavior on the agent path, which stays F11). Agent tool-round accumulation is F11 and
out of scope (no agent-path budget test). Ordering within the slow path is unchanged
and deliberate: key/model/endpoint checks, `ensureOllama`, and `checkModelListed`
(`:520`) run before assembly + budget — authoritative preconditions first (a budget
verdict is meaningless if the model is absent; the ollama-pull cost exists today
regardless) — then the probe call. "No LLM call" holds either way.

```
Omitted <M> fast finding(s) to fit the prompt budget.
```

Cut order, each leaving its explicit record:

1. **Linked-issue context**: allowance = `budget − (diffSection + findingsJSON + framing + issueOverhead)`, all in bytes on the assembled regions, where `framing` is everything else in the user message (section headers except the `## Linked issue` header, skipped-files note, JSON brackets/commas, plus the omission line at its current count — step 1 sizes with `omitted = 0`, step 2 re-computes with the running count) and `issueOverhead` is the whole fixed cost of carrying any issue text (`## Linked issue…` header + `\n\n` separators + `<linked-issue>` tags + marker, all as exact `Buffer.byteLength` values computed in code, ≈145 bytes total — nothing estimated, nothing double-counted). `budgetPrompt` neutralises every region FIRST — issue text, diff text, and the findings-JSON `<`→`\\u003c` escaping, identical to `buildMessages` (`prompt.ts:50,59,62`) — which requires exporting `neutralise` plus the issue header/tags/marker as constants from `src/prompt.ts` (listed as plan change sites; neutralise is idempotent so `buildMessages` re-rendering is a no-op). Every measurement and cut operates on the neutralised regions; the returned regions are already neutralised. If the full block fits, it is kept uncut (no marker). Otherwise truncate to the allowance with the marker (balanced tags); when the allowance is negative, drop the block entirely (`issueBody: undefined`, `issueDropped: true` — the correct degradation, identical to a PR with no linked issue). The cut is byte-exact, then backed off over a trailing partial UTF-8 sequence (ASCII splits, including `&lt;`-style entities, decode cleanly and need no handling). No closed-form constant is needed beyond these definitions: the loop re-renders via `buildMessages` and re-measures after every cut, so the omission count is always current and the total never exceeds the budget.
2. **Fast findings**: drop whole findings from the tail until in budget, counting
   them in `findingsOmitted`. Never mid-finding truncation — the JSON stays
   parseable. Order is positional (pipeline order: deterministic L0/scanner evidence
   first, toolchain L2 last — no severity reordering, no policy change). The issue
   allowance is computed once against the full findings set and never re-expanded:
   step 2 does not restore issue text (literal approved order, stated so no reader
   infers recomputation from "re-measures after every cut" — re-measurement covers
   the running total only).
3. **Diff**: never cut below its own contract. If the diff section alone exceeds the
   budget, or anything remains over budget after (1)+(2), the slow path skips with
   a warning naming both sizes
   (`prompt <bytes> exceeds max_prompt_chars <budget> after bounded cuts`).
`budgetPrompt` is exported (tests import it from `src/main.ts`, where it is defined).
`skipped` passes through unchanged and `issueDropped` is returned (not derived by callers)
because the single 6-arg `buildMessages` call needs all regions in one place; the caller
logs `linked issue context dropped to fit the <budget>-byte prompt budget` when
`issueDropped` is true. The agent-mode linked-repos `conv.turns` user
message (`:584`) sits outside the budget (agent-turn context, F11).

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
green proves the identity on fixtures (required verification). Early-artifact note: `:805` changes from `redact(raw)` to `redact(sanitize(raw))` — a secret straddling the 2,000-code-point `MSG_CAP` now persists partially there, exactly the straddle exposure `:822` already had (stated, not hidden). `redactFindings`
ordering (F02) is untouched, and the prompt path stays unredacted (pre-existing;
stated explicitly, out of scope).

## 3. Tests

`tests/prompt.test.ts` (assembler unchanged; renderer tests added) plus `tests/main.test.ts`
`describe("prompt budget")` (TDD; small `maxPromptChars` overrides, e.g. 2000, so
fixtures stay small — one 4,000-character TODO line no longer suffices since
`MSG_CAP` bounds each finding and the overflow needs many findings or a small budget):

- Oversized issue body truncates with the marker; tags stay balanced; rest intact.
- Issue block dropped when the allowance is negative: budget 3,200 with a ~2,900-byte diff, one small finding (~200 B), and a ~5,000-byte issue → allowance = 3200 − (2900 + 200 + framing ~165 + overhead ~147) < 0 → `issueDropped`, `issueBody` undefined; step 2 then drops the finding too (`findingsOmitted = 1`, total ≈ 3,065 + 51 omission line < budget) and the review proceeds without issue context — deterministic; the finding pins the allowance so a zero-finding fixture cannot silently truncate instead.
- Fast-findings overflow drops whole tail findings with an exact omitted count rendered
  as the prose line after the findings JSON; the surviving JSON parses.
- Diff is never cut below `maxDiffChars` (over-budget fixture with maxed diff →
  slow-path skip, not a cut diff).
- Still-over-budget-after-cuts skips with the size-naming warning; no LLM call.
  Two fixtures: (a) diff-alone: ASCII diff at default `maxDiffChars` scale with
  `maxPromptChars: 1000` (diff section alone exceeds the budget — deterministic, no
  multibyte needed); (b) after-cuts with `maxPromptChars: 6000`: diff file with a ~5,200-byte hunk (fits the 6,000
  budget alone) + 25 tiny skipped files (note capped at 20 ≈ 700 B) + framing ≈ 200 B, with
  a linked issue and fast findings present: issue dropped, findings dropped to zero,
  yet diff + note + framing ≈ 6,100 > 6,000 → skip (pins the branch where cuts are
  exhausted yet the total still overflows; `maxDiffChars: 5500` with the 5.2 KB file
  first in patch order so exactly it is included and 25 tiny files (~300 units each,
  each above the ~270-unit leftover gap — 5500 − (5200 + ~30 header) — so all skip) skip
  — the test computes exact `Buffer.byteLength` sums rather than asserting magic constants).
- Pure-renderer tests in `tests/prompt.test.ts`: the `omitted` prose line renders after
  the findings JSON via the 6th param; the skipped-files list caps at 20 with the
  `…and <N> more` line (both pure `buildMessages` assertions, no budget needed).
- Multibyte floor: 8 files of ~7,450 CJK units each (≈60,000 UTF-16 units ≈ 180,000
  bytes; each file under the 8,000-unit `PER_FILE_CAP` so no per-file cut shrinks it —
  note the `--- path` headers and trailing newline count toward `maxChars`, so 7,500
  would total ≈60,240 and skip the 8th file)
  with default 120,000-byte budget skips — this is intended default-config behavior for
  diffs averaging over 2 bytes per UTF-16 unit (CJK, Cyrillic, Greek, accented Latin —
  the bytes-versus-units rule, not a script list), pinned so the unit fix cannot regress.
- `tests/inputs.test.ts`: `maxPromptChars` defaults to 120,000; add `max_prompt_chars`
  to `INPUT_NAMES` and the smoke-test declared-inputs list; 0/negative/non-numeric
  are rejected naming the input (`readInt` floor 1 = minimum accepted, never a clamp),
  `1` accepted.
- Control characters / over-long fields in fast findings are stripped/capped in the
  captured prompt (pre-LLM sanitization).
- `ActionInputs` fixture updates (`tests/main.test.ts:173`, `tests/evals/harness.ts:32`).
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
F14, template/CI changes, other new inputs or dependencies, redacting the prompt path.
(`buildMessages` keeps its regions and order — the `omitted` parameter and the
20-entry skipped-list cap are the two approved extensions.)
