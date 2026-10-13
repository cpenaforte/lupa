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
strict-marker condition). Capability matrix (honest): the JSON schema is
API-enforced only on `openai`/`opencode-zen`/`opencode-go`
(`FULL_SCHEMA_PROVIDERS`, `llm.ts`); `anthropic` gets no schema and all other
providers get `json_object` — on those paths `patch` is a contract field
described by the instruction sentence, not API-enforced. Owner ruling: the
prompt-described typed key COUNTS as the policy's "typed field" — the field
is type-validated by `toFindings` on every path (a wrong-typed patch never
fences anywhere), and the instruction sentence carries the semantics where no
schema is sent. Residual (accepted): on prompt-only paths a model that puts
prose in `patch` still fences it — same non-compliance class as any ignored
instruction, mitigated by the pinned sentence (§4). `suggestion` becomes
advice-only prose. Rendering fences **iff** a non-empty patch meets a valid
RIGHT-side line target (the policy's fallback validation, kept as the second
gate). Rejected: in-string marker (free-text convention fragility — the
failure mode Q01 fixes); target-only validation (leaves prose-on-valid-lines
fenced — the audit's actual cases).

## 3. Interfaces

```ts
// fastpath.ts — contract addition (Finding home)
patch?: string; // replacement code for the flagged line; absent = no patch claim
// prompt.ts — schema addition (scalar, google-safe; same pattern as confidence)
patch: { type: ["string", "null"] } // + "patch" in item required + converted expectation
// llm.ts — toFindings carries patch (null/absent → absent; wrong type → field dropped, finding kept — confidence precedent, llm.ts:227-233)
// review.ts — rendering split
export function hasPatch(f: Finding): f is Finding & { patch: string }; // trimmed-nonempty test on the stored value (stored verbatim, never trimmed)
export function formatBody(f: Finding, side: "LEFT" | "RIGHT", reopened?: boolean): string; // signature unchanged
// main.ts — isFinding accepts optional string patch; sanitizeFinding caps + control-strips it (SUGGESTION_CAP); redactFindings redacts it with the same keys
// review.ts — survivor: patch = first member satisfying hasPatch in member order, absent iff none (stricter than evidence.snippet: a whitespace-only patch must not shadow a valid one)
```

## 4. Exact behavior

- **Fence rule.** `formatBody(f, "RIGHT")` renders the applicable fence
  **iff** `hasPatch(f)` — fence content is `patch`, stored verbatim and
  rendered verbatim (`${fence}suggestion\n${patch}\n${fence}`, no trimming at
  render — the trim lives only in the `hasPatch` test). Order on RIGHT:
  message head, then the fence block, then `Suggested: <suggestion>` advice
  text when a suggestion exists, then the provenance trailer.
  `suggestion`, when present, always renders as `Suggested:` advice text —
  including on RIGHT hits (it no longer fences anywhere). No patch, empty
  patch, or whitespace-only patch → no fence, ever.
- **Target rule (display side unchanged).** The `side` argument still comes
  from `mapToComments` RIGHT-then-LEFT resolution; only RIGHT-side hits are
  fence-eligible. A patch on a LEFT hit or general-body item renders first a
  label line `Suggested replacement (advice only):` then a plain fenced code
  block (```, never ` ```suggestion `), then the `Suggested:` text when a
  suggestion exists; continuation lines inside `- ` body items indent with
  `\n  ` like the existing `Suggested:` rendering. Trailer placement follows
  the Q04 rule (after any fence or `Suggested:` block, never inside).
- **Multiline allowed.** Patch content may span lines (GitHub replaces the
  flagged line with the block); no single-line enforcement in v1 (findings
  themselves stay single-line — `start_line`/`start_side` still never set).
- **Prompt.** One instruction sentence appended on the single-shot path next
  to the `DEDUP_INSTRUCTIONS`/`confidence` sentences (same gate — agent
  SYSTEM prompt byte-identical; the shared SYSTEM JSON hint is frozen for the
  same reason). Required content (pinned wording for tests): "Set `patch`
  to the exact replacement code for the flagged line, and only then; put all
  explanations in `suggestion`; use null when there is no replacement."
  Agent mode gets the field through the shared schema/parser, and patch is
  content, not provenance, so `stripProvenance` leaves it alone.
- **Validation shapes.** `isFinding`: patch absent or string (else violation
  as today). `toFindings`: `patch: null`/absent → field absent; wrong-type
  patch → field dropped, finding kept (confidence precedent — a single
  malformed patch must never discard the whole review; verdict-index
  alignment holds because positions are untouched). `sanitizeFinding`: cap
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
  `tests/prompt.test.ts:150` sorted property-keys list gains `patch`;
  `tests/adapters-google.test.ts:48` + `:551` required lists gain `patch`
  (nullable-string conversion covered by the existing conversion test);
  `tests/probe-routing.test.ts` + `tests/adapters-routing.test.ts`
  single-shot pins; agent prompts byte-identical (no agent pin changes).
- `toFindings`: patch carried; `null`/absent → absent; wrong-type patch →
  field dropped, finding kept (finding kept when patch absent but suggestion
  present).
- Rendering matrix (`tests/review.test.ts`): RIGHT+patch → fence with patch
  content verbatim, then `Suggested:` advice, then trailer; RIGHT+suggestion-only
  → advice, no fence; empty/whitespace-only patch → no fence; LEFT+patch →
  `Suggested replacement (advice only):` label + plain fenced block, then
  `Suggested:` text; general-body same shapes with \n-indentation;
  fallback `- Proposed patch (advice only):` row via `field()`; trailer
  fence-external with patch present. Existing RIGHT-fence tests migrate from
  `suggestion` to `patch` (`:122-127`, `:151-158` backtick fence, `:877-883`
  trailer) — migrate, never delete.
- Audit pins (new tests replicating the audit shapes — the canary bodies live
  outside this tree): credential-rotation prose and SQL-shaped prose in
  `suggestion` render as advice, never fenced; one genuine one-line
  replacement in `patch` still fences.
- Instruction sentence pinned verbatim (§4); parser-tolerance: a re-posted
  reopened thread keeps parsing (patch never touches the head line).
- Sanitizer caps + control-strip; redaction of a secret inside patch on every
  surface shape; survivor first-hasPatch-wins + absent-iff-none.
- README gains a 3-line note (exact text): suggestions render as applicable
  code changes only when the model supplies replacement code; explanatory
  text always renders as advice; pinned by one `tests/readme.test.ts` phrase.
- Full suite + evals green; `failLevel` semantics unchanged (patch never gates).

## 6. Implementation split (plan preview)

Two sequential tasks: (i) contract + prompt/schema + toFindings + sanitizers
(`Finding.patch`, schema/required/converted/instruction,
`hasPatch`+`toFindings`, isFinding/sanitize/redact, pin updates); (ii)
rendering + survivor + fallback + docs (`formatBody` split, body/fallback
rows, survivor rule, README note + pin, audit pins, evals). Task (ii)
consumes (i)'s field; no parallel work.

## 7. Constraints and residuals

No new runtime dependencies, no new action inputs, stable namespace
(`pr-reviewer-*`, `lupa:` prefixes), no template/CI changes, `dist/`
committed per task, suite + evals green. Ships with the next release
vehicle — no tag alone. Accepted residuals: models may still put code in
`suggestion` (renders as advice — fail-safe direction); prose-in-`patch`
on prompt-only (non-schema) provider paths still fences (instruction sentence
is the only guard there); patch correctness is never validated (applicability
only, never auto-apply); multi-line range targeting stays v1-out-of-scope;
fence-parity miscount on truncation mid-fence is pre-existing (isFenceLine
counts any ``` opener — unchanged by this spec).
