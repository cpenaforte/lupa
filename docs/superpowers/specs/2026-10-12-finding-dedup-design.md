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
// links: [responsePosition, sentIndex] from per-finding duplicateOf pointers
interface LlmResult { ok: boolean; findings: Finding[]; verdicts?: DedupVerdicts; … }
```

- `toFindings` (or a sibling parser — named per task) returns
  `{ findings, verdicts }`; unknown indices, self-pairs, dangling pointers,
  and non-pair entries are dropped from `verdicts` HERE (counted for the
  malformed warning below), so downstream only sees valid verdicts.
- Every adapter passes `verdicts` through on its `LlmResult` (absent = no
  verdicts; agent-mode and non-JSON paths leave it absent — the agent prompt
  carries no dedup contract, so agent runs never merge).
- `sanitizeFinding`, `isFinding`, and the Finding contract are untouched.

### Prompt contract and schema

- The sent array is the POST-CUT fast list (`b.fast` after F10 budget cuts):
  IDs are indices into exactly what the model sees. Tail indices cut by the
  budget are not sendable — verdicts referencing them are unknown by
  construction. Published output is unchanged when no verdicts return; the
  PROMPT gains IDs + verdict instructions (ID bytes count against the F10
  budget like any prompt bytes — the cut point moves).
- Strict-provider schema (nullable-required, replacing the impossible
  "optional" shape):
  ```json
  "duplicates": { "type": ["array", "null"],
    "items": { "type": "array", "prefixItems": [{"type": "integer"}, {"type": "integer"}], "minItems": 2, "maxItems": 2 } },
  "duplicateOf": { "type": ["integer", "null"] }
  ```
  Both keys join the item/top-level `required` lists they belong to (the
  `prompt.test.ts` required-list pins update — named per task). A 400 from
  a strict provider falls back through the existing probe path. Model
  findings use `duplicateOf` to restate sent findings (response findings
  have no sent ID to pair with).

### Deterministic merge (`mergeDuplicates`, `review.ts`, exported)

Merge point: inside `publishReview`, AFTER gate inputs are fixed —
`eventFor`/`exitFor` keep receiving the FULL pre-merge set (F15 tests
unchanged), and gate outcomes are provably identical on the merged set
(severity-max preserves `some high` and `some non-info`; verified case by
case — the merged set only changes counts, never the predicates).

1. Verdict groups union by transitive closure over member positions
   (pairs of sent indices; links of response positions to sent indices).
2. Same-location precondition: members must share `file`, and lines must be
   both-undefined or equal — else the pair/link is ignored with a warning
   (a wrong model pair must never swallow an unrelated location).
3. Partially-valid pairs are dropped whole (the valid member stays alone —
   never merge on partial evidence).
4. Survivor per group, in first-member-position order (stable, deterministic):
   `file`/`line` = the defined member's (precondition makes them coherent);
   `rule` = distinct member rules joined with `"+"` in group order
   (identical rules collapse: `[github-pat, github-pat]` → `"github-pat"`);
   `severity` = max; `message` = members in group order as
   `` `[${rule}] ${message}` `` joined with `"\n\n"` (no text rewritten),
   then re-capped with the existing message cap + marker (bounded output
   beats completeness); `suggestion` = first defined suggestion in group
   order.
5. F15 funnel (top-N → inline → body) runs on the merged set; marker counts
   reflect post-merge totals. `sarif.json` is built from the merged set
   (publication surface); `findings.json` keeps the pre-merge set (F15
   artifact contract intact).

### Verdict persistence across flows

- Flow A: the artifact writes the pre-merge set AND `verdicts.json`
  (`{pairs, links}`, validated arrays of int-pairs).
- Flow B: reads `verdicts.json` best-effort (missing/malformed → warning +
  no merge — fail-soft, same family as the verdict rules) and merges in the
  same `publishReview` point. Fork-PR comments dedup identically.

### Failure behavior

- Slow path skipped (no key): no judge exists → duplicates stay.
  `core.info("lupa: dedup skipped (slow path unavailable); scanner findings published unmerged")` (exact) + README dedup section documents it.
- Malformed `duplicates` section / unknown indices / dangling pointers:
  counted at parse, one warning, entries dropped, all findings kept.

## 3. Tests

Mocked-LLM, deterministic (no live provider), verdicts expressed through the
`okChat`-style mocked reply content (`llm.test.ts` + adapter tests) and the
merge function directly (`review.test.ts`):
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
