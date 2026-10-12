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
interface DedupVerdicts {
  pairs: Array<[number, number]>;
  links: Array<[number, number]>;
  malformed: number; // shape-bad entries dropped at parse + out-of-sent-range verdicts dropped at send
}
// pairs: sent-list indices. links: ABSOLUTE all-list indices
// [allIndex, sentIndex] — converted at the boundary (slowPath maps each
// response-relative position r to fast.length + r), so the merge and Flow B
// consume one index space with no fast count anywhere downstream.
interface LlmResult { ok: boolean; findings: Finding[]; verdicts?: DedupVerdicts; … }
```

- New sibling parser `parseVerdicts(parsed: unknown): DedupVerdicts`
  (`llm.ts`, exported, unit-tested): takes the ALREADY-PARSED response
  object (adapters parse once via `parseContent` — fence handling inherited,
  no double parse). Shape validation ONLY: drops negativity/non-integer
  indices, self-pairs, non-pairs, and wrong-length pairs (each drop
  increments `malformed`). Referent checks (unknown sent indices, dangling
  pointers) belong to the CALLER holding the arrays — `slowPath` range-checks
  against the kept count, the merge range-checks against `findings.length`
  (see below). Null and absent verdict keys both mean "no verdict"
  (schema-less providers and the Google no-schema fallback never emit them —
  that is normal, not malformed). `toFindings`, `sanitizeFinding`,
  `isFinding`, and the Finding contract are untouched.
- Every adapter attaches the whole `parseVerdicts(parsed)` object on the
  `LlmResult` it builds (absent only where there is no parsed JSON body);
  the probe carries the WINNING style's result, verdicts included (a
  schema-caused 400 walks the other styles first — pinned behavior, unchanged;
  a losing style's verdicts never leak).
- `slowPath` returns `{ findings, verdicts? } | undefined`
  (`Promise<{ findings: Finding[]; verdicts?: DedupVerdicts } | undefined>`);
  on success it converts links to absolute (`allIndex = fast.length + r`
  using the UNCUT `fast` parameter — never `b.fast.length`),
  drops verdicts with sent index ≥ `b.fast.length` (cut tail — unseen by
  construction) counting them into `malformed`, and warns
  `lupa: ignored <n> malformed dedup verdict(s)` (exact shape) iff
  `malformed > 0`. The agent-mode return carries `verdicts` absent (no
  contract there — agent runs never merge, and log nothing about it, by
  design); every slow-path skip returns `undefined` as today.
- `PublishArgs` gains `verdicts?: DedupVerdicts` (no return-type change —
  `publishReview` stays `void`).

### Prompt contract and schema

- The sent array is the POST-CUT fast list (`b.fast` after F10 budget cuts):
  IDs are indices into exactly what the model sees, rendered as an `"id"`
  field on each finding object with ALL other fields complete and untruncated
  (full message + suggestion bodies — the model judges on substantive
  content, never bare IDs or locations). IDs render through
  `budgetPrompt(..., opts?: { withIds?: boolean })` (default off), which the
  slow path passes as true so ID bytes move the cut point; the
  agent-mode branch rebuilds its messages without IDs (fewer bytes than
  measured — still within budget). Tail indices cut by the
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
  have no sent ID to pair with). The verdict instructions (`DEDUP_INSTRUCTIONS`,
  appended to the single-shot system text only) name the `duplicates` /
  `duplicateOf` fields, 0-based indices into the sent list, and pair arrays —
  the full shape for schema-less providers that never see the JSON schema.

### Deterministic merge (`mergeDuplicates(findings, verdicts)`, `review.ts`, exported)

All indices absolute (pairs are sent indices; links were converted at the
boundary — the merge performs no offset arithmetic). Called in exactly two
places with identical (pre-merge, verdicts) inputs — `publishReview` for the
funnel and `runFlowA` for the `sarif.json` line (same pure function, same
result; never on already-merged output). Shared text caps (`MSG_CAP`,
`RULE_CAP`, `capText`, `TRUNC_MARK`) move to `fastpath.ts`
(finding-contract home, no import cycles), with `main.ts` and `review.ts`
importing them — behavior unchanged.

Merge point: inside `publishReview`, AFTER gate inputs are fixed —
`eventFor(fullSet)`, `summaryFor(fullSet)`, and the dry-run `high=` count
keep the full pre-merge set (already order-free calls — no reordering
needed); `mapToComments`/`buildBody` take the merged set. `exitFor` sites
outside (Flow A/B) are untouched. Gate outcomes are provably identical on
either set, so the F15 "full set" tests stay green unchanged.

1. Verdict groups union by transitive closure over member positions
   (absolute indices throughout). Group member order is position order —
   every ordered rule below follows it. `mergeDuplicates` returns
   `{ merged, dropped }`; `publishReview` logs
   `lupa: ignored <n> unmergeable dedup verdict(s)` (exact shape) iff
   `dropped > 0`.
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
5. F15 funnel (top-N → inline → body) runs on the merged set; the omission
   marker counts ONLY the top-N cut (`merged.length − topN.length`) —
   merged-away findings are represented inside survivors, never counted as
   omitted (a naive `fullSet − retained` overcounts them); marker counts
   reflect post-merge totals. `sarif.json` is built from the merged set
   (publication surface); `findings.json` keeps the pre-merge set (F15
   artifact contract intact).

### Verdict persistence across flows (inside pr-meta.json — no template change)

The artifact upload list is explicit and template changes are out of scope,
so verdicts ride the already-uploaded `pr-meta.json`: `PrMeta` gains
`verdicts?: DedupVerdicts`, and `readPrMeta` returns it (validated shape:
`{pairs, links}` arrays of non-negative-int pairs plus non-negative-int
`malformed`; anything else under a PRESENT key throws like any contract
violation — a corrupt advisory block refuses like a corrupt binding field,
fail-closed and consistent; a MISSING key means "no judge ran" and merges
nothing, silently).

- Flow A: `pr-meta.json` is (re)written with verdicts after the slow path
  (always written, even `{pairs: [], links: [], malformed: 0}` when there is
  no LLM — a missing verdicts key means "no judge ran").
- Flow B: reads verdicts from `pr-meta.json` best-effort under the F15
  artifact read cap (oversize/unparseable → warning + no merge) and
  range-checks every index against `findings.length` (out-of-range =
  malformed, dropped with the count); then merges in the same
  `publishReview` point. Fork-PR comments dedup identically.

### Failure behavior

- Slow path skipped (any reason — no key, empty model, unresolvable
  endpoint, unlisted model): no judge exists → duplicates stay. The
  existing skip paths call `note()`; the dedup line goes through it too
  (`core.info` + step summary): `lupa: dedup skipped (slow path
  unavailable); scanner findings published unmerged` (exact). README dedup
  section documents it.
- Malformed `duplicates` section (shape-bad entries): counted in
  `parseVerdicts` (`malformed` count); referent failures (unknown sent
  indices, dangling pointers) are counted at the range checks (slowPath
  cut-tail, merge out-of-range). The slow path logs one
  `core.warning("lupa: ignored <n> malformed dedup verdict(s)")` (exact
  shape) for the parse+send counts and drops the entries; all findings kept.

## 3. Tests

Mocked-LLM, deterministic (no live provider), verdicts expressed through the
`okChat`-style mocked reply content (`llm.test.ts` + adapter tests,
including the converted-schema expectation in `adapters-google.test.ts`)
and the merge function directly (`review.test.ts`):
- Canary-exact pair (gitleaks + semgrep `github-pat` on one file:line → one
  comment, `high`, rule `"github-pat"`, secret still redacted) + Flow B twin
  (same verdicts via a pr-meta fixture carrying the verdicts key).
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
