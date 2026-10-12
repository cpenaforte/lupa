# Sub-project: scanner finding dedup (LLM-judged pairs, deterministic merge) — design

Date: 2026-10-12
Status: draft
Source: lupa#22 (v0.6.0 canary: gitleaks `github-pat` + semgrep `github-pat`
flag the same secret with different bodies), audit Evolutions §6
Goal: the same evidence stops producing two review comments. The LLM judges
duplication; deterministic code merges. Nothing observable becomes
model-nondeterministic.

## Decisions (approved in brainstorming)

- Scope: dedup only (prompt contract, response parsing, merge function,
  owning tests). No gate, severity-policy, template, or CI changes.
- The model judges PAIRS, code merges (approach B): severity, rendering, and
  marker accounting stay deterministic and testable.
- No-LLM runs keep duplicates with a documented note (no behavior change
  where no judge exists).
- The merge never drops a finding it cannot account for (fail-soft on
  malformed verdicts — worst case, duplicates stay).
- Follows the standing pipeline (spec review → plan → plan review → SDD →
  PR); ships with the next release vehicle, no tag alone.

## 1. Problem

Scanner findings concatenate (`fast` + LLM arrays): two scanners firing on
the same secret produce two inline comments with different bodies
(`**high** [github-pat] Artifact: leak.py … Match: …` vs `**warning**
[github-pat] github-pat has detected secret for file /src/leak.py`). Same
evidence, double noise. Rule IDs differ across scanners in general, so no
static key separates "same finding" from "two findings on one line".

## 2. Design

### Verdict transport (out-of-band, order-preserving)

Sanitizers rebuild findings from known fields, so verdicts never ride on
finding objects. The parse layer extracts them separately, keyed by
position (every pipeline stage below is order-preserving, so positions stay
aligned):

```ts
// llm.ts, alongside LlmResult:
interface DedupVerdicts { pairs: Array<[number, number]>; links: Array<[number, number]> }
// pairs: sent-list indices. links: ABSOLUTE all-list indices
// [allIndex, sentIndex] — converted at the boundary (slowPath maps each
// response-relative position r to fast.length + r), so the merge and Flow B
// consume one index space with no fast count anywhere downstream.
interface LlmResult { ok: boolean; findings: Finding[]; verdicts?: DedupVerdicts; … }
```

- New sibling parser `parseVerdicts(rawText: string): { verdicts: DedupVerdicts; malformed: number }`
  (`llm.ts`, exported, unit-tested): reads the SAME raw response text as
  `toFindings` and returns links response-relative (`[responsePosition,
  sentIndex]`, 0-based within the response findings array). Drops unknown
  indices, self-pairs, dangling pointers, non-pairs, and wrong-length pairs
  HERE (each drop increments `malformed`); null and absent verdict keys both
  mean "no verdict" (schema-less providers and the Google no-schema fallback
  never emit them — that is normal, not malformed). `toFindings`,
  `sanitizeFinding`, `isFinding`, and the Finding contract are untouched.
  `slowPath` converts to absolute (`allIndex = fast.length +
  responsePosition`) before returning or persisting — every consumer below
  sees absolute indices only.
- Every adapter attaches `verdicts: parseVerdicts(raw)` on the `LlmResult`
  it builds (absent only where there is no raw JSON text); the probe carries
  the WINNING style's result, verdicts included (a schema-caused 400 walks
  the other styles first — pinned behavior, unchanged).
- `slowPath` returns `{ findings, verdicts } | undefined`
  (`Promise<{ findings: Finding[]; verdicts: DedupVerdicts } | undefined>`);
  the agent-mode return carries `verdicts` absent (no contract there — agent
  runs never merge, and log nothing about it, by design); every slow-path
  skip returns `undefined` as today.
- `PublishArgs` gains `verdicts?: DedupVerdicts`; `publishReview` returns
  `Promise<{ merged: Finding[] }>` (callers may ignore it).

### Prompt contract and schema

- The sent array is the POST-CUT fast list (`b.fast` after F10 budget cuts):
  IDs are indices into exactly what the model sees. Tail indices cut by the
  budget are not sendable — verdicts referencing them are unknown by
  construction. Published output is unchanged when no verdicts return; the
  PROMPT gains IDs + verdict instructions ONLY in the single-shot call path
  (the shared `buildMessages` builder is untouched, so agent prompts never
  see IDs — agent mode has no verdict source). ID bytes count against the F10
  budget like any prompt bytes — the cut point moves.
- Strict-provider schema (no `prefixItems` anywhere — length checks live in
  the parser, keeping every adapter's converter untouched):
  ```json
  "duplicates": { "type": ["array", "null"],
    "items": { "type": "array", "items": { "type": "integer" }, "minItems": 2, "maxItems": 2 } },
  "duplicateOf": { "type": ["integer", "null"] }
  ```
  Both keys join the item/top-level `required` lists they belong to (the
  `prompt.test.ts` required-list pins AND the `adapters-google.test.ts`
  converted-schema expectation update — named per task). A 400 from
  a strict provider falls back through the existing probe path (Google: the
  in-adapter retry without schema, whose keyless reply parses as
  no-verdicts). Model
  findings use `duplicateOf` to restate sent findings (response findings
  have no sent ID to pair with).

### Deterministic merge (`mergeDuplicates(findings, verdicts)`, `review.ts`, exported)

All indices absolute (pairs are sent indices; links were converted at the
boundary — the merge performs no offset arithmetic). Shared text caps
(`MSG_CAP`, `RULE_CAP`, `capText`, `TRUNC_MARK`) move to `fastpath.ts`
(finding-contract home, no import cycles), with `main.ts` and `review.ts`
importing them — behavior unchanged.

Merge point: inside `publishReview`, AFTER gate inputs are fixed —
`eventFor(fullSet)`, `summaryFor(fullSet)`, and the dry-run `high=` count
keep the full pre-merge set (already order-free calls — no reordering
needed); `mapToComments`/`buildBody` take the merged set. `publishReview`
returns the merged set for the `sarif.json` line (no second merge anywhere
— re-merging shifted positions would be unsound). `exitFor` sites outside
(Flow A/B) are untouched. Gate outcomes are provably identical on either
set, so the F15 "full set" tests stay green unchanged.

1. Verdict groups union by transitive closure over member positions
   (pairs of sent indices; links of response positions to sent indices).
   Group member order is position order (sent indices, then response
   positions) — every ordered rule below follows it.
2. Same-location precondition: members must share `file`, and lines must be
   both-undefined or equal — else the pair/link is ignored with a warning
   (a wrong model pair must never swallow an unrelated location).
3. Partially-valid pairs are dropped whole (the valid member stays alone —
   never merge on partial evidence).
4. Survivor per group, groups in first-member-position order (stable,
   deterministic): `file`/`line` = the defined member's (precondition makes
   them coherent); `rule` = distinct member rules joined with `"+"` in group
   order, then re-capped at `RULE_CAP` like any rule (identical rules
   collapse: `[github-pat, github-pat]` → `"github-pat"`); `severity` = max;
   `message` = members in group order as `` `[${rule}] ${message}` `` joined
   with `"\n\n"` (no text rewritten), then re-capped with the existing
   message cap + marker (bounded output beats completeness); `suggestion` =
   first defined suggestion in group order.
5. F15 funnel (top-N → inline → body) runs on the merged set; marker counts
   reflect post-merge totals. `sarif.json` is built from the merged set
   (publication surface); `findings.json` keeps the pre-merge set (F15
   artifact contract intact).

### Verdict persistence across flows

- Flow A: the artifact writes the pre-merge set AND `verdicts.json`
  (`{pairs, links}`, validated arrays of int-pairs). Flow A always writes
  `verdicts.json`, even `{pairs: [], links: []}` when there is no LLM —
  a missing file is never a normal state.
- Flow B: reads `verdicts.json` best-effort under the F15 artifact read cap
  (oversize/unparseable → warning + no merge) and range-checks every index
  against `findings.length` (out-of-range = malformed, dropped with the
  count); then merges in the same `publishReview` point. Fork-PR comments
  dedup identically.

### Failure behavior

- Slow path skipped (any reason — no key, empty model, unresolvable
  endpoint, unlisted model): no judge exists → duplicates stay. The
  existing skip paths call `note()`; the dedup line goes through it too
  (`core.info` + step summary): `lupa: dedup skipped (slow path
  unavailable); scanner findings published unmerged` (exact). README dedup
  section documents it.
- Malformed `duplicates` section / unknown indices / dangling pointers:
  counted in `parseVerdicts` (`malformed` count); the slow path logs one
  `core.warning("lupa: ignored <n> malformed dedup verdict(s)")` (exact
  shape) and drops the entries; all findings kept.

## 3. Tests

Mocked-LLM, deterministic (no live provider), verdicts expressed through the
`okChat`-style mocked reply content (`llm.test.ts` + adapter tests,
including the converted-schema expectation in `adapters-google.test.ts`)
and the merge function directly (`review.test.ts`):
- Canary-exact pair (gitleaks + semgrep `github-pat` on one file:line → one
  comment, `high`, rule `"github-pat"`, secret still redacted) + Flow B twin
  (same verdicts via `verdicts.json` fixture).
- Model-finding `duplicateOf` a scanner finding → one comment citing both.
- Transitive triple → one; cross-file pair ignored with warning (locations
  preserved); partially-valid pair dropped whole; unknown-ID and
  malformed-section cases keep every finding with a warning.
- No-section response: published output byte-identical (prompt bytes differ
  by the IDs — stated, not tested as identical).
- No-LLM run unchanged + exact skip note asserted in logs.
- Agent-mode run: no verdicts, no merge (assert passthrough).
- F15 marker counts on the merged set; SARIF alert count equals merged count.
- Gate-equivalence: paired high+warning fixture gates REQUEST_CHANGES/1
  identically pre/post merge (documents the predicate proof).

## 4. Verification and release

- Gates: focused tests, full `vitest`, `tsc --noEmit`,
  `npm run build && node --check dist/index.js`, committed `dist/`.
- No canary (mock-pinned paths); ships with the next release vehicle.

## Out of scope

Q01–Q04 mechanisms, gate/blocking changes, suggestion rendering, template/CI
changes, new inputs or dependencies, rule-overlap static maps.
