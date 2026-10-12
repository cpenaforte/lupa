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

### Prompt contract

The review prompt's scanner/fastpath findings list gains stable numeric IDs
(index in the sent array — deterministic across runs). The response schema
gains one optional section:

```ts
duplicates?: Array<[number, number]>  // pairs of finding IDs, same evidence
```

Response findings (the model's own) carry no sent-list ID, so a model
finding that restates a scanner finding cannot appear in a pair. For that
direction the schema allows a per-finding pointer instead:

```ts
// on a response finding:
duplicateOf?: number  // sent-list index this finding restates
```

Both mechanisms feed the same merge (§2): pair groups and `duplicateOf`
links union together. No `duplicates` section AND no `duplicateOf` pointers
= "no duplicates" verdict (normal, not an error).
Pairs/pointers reference sent-list indices only.

### Deterministic merge (code)

1. Pairs AND `duplicateOf` pointers union into groups by transitive closure
   (A=B, B=C → one group; a response finding pointing at a sent finding
   joins that finding's group).
2. Unknown indices, self-pairs, dangling pointers, and non-pair entries are
   ignored with a warning; every finding stays unless merged through a valid
   pair or pointer.
3. Per group: severity takes max (`high` > `warning` > `info`); evidence =
   concatenated member messages each tagged with its source rule (no text
   rewritten); renders as ONE inline comment / one body item citing all
   member rules.
4. F15 top-N/marker accounting runs AFTER merging — the merged set is what
   is published, counted, and gated. The full pre-merge set stays in the
   `findings.json` artifact unchanged.

### Failure behavior

- Slow path skipped (no key): no judge exists → duplicates stay; documented
  in the no-LLM note. No other behavior changes.
- Malformed `duplicates` (unknown IDs, self-pairs, non-arrays, wrong shapes):
  ignore the bad entries with a warning, keep all findings.

## 3. Tests

Mocked-LLM, deterministic (no live provider): canary-exact pair (gitleaks +
semgrep `github-pat` on one file:line → one comment, `high`, both rules
cited, secret still redacted); model-finding `duplicateOf` a scanner finding
→ one comment citing both; transitive triple → one; unknown-ID and
malformed-section cases keep every finding with a warning; no-section
response is byte-identical to today; no-LLM run unchanged; F15 marker counts
asserted on the merged set (omitted count reflects post-merge totals).

## 4. Verification and release

- Gates: focused tests, full `vitest`, `tsc --noEmit`,
  `npm run build && node --check dist/index.js`, committed `dist/`.
- No canary (mock-pinned paths); ships with the next release vehicle.

## Out of scope

Q01–Q04 mechanisms, gate/blocking changes, suggestion rendering, template/CI
changes, new inputs or dependencies, rule-overlap static maps.
