# Sub-project 2: native provider protocols and review-trigger isolation — design

Date: 2026-10-11
Status: design approved (2026-10-11); review round 1 applied (2026-10-11)
Source: Codex audit `PROJECT_FINDINGS.md` (F04, F05, F06), local HEAD `458bd34`
Goal: close the remaining P1 findings before any deployment expansion — make native
Google/Anthropic endpoints usable end-to-end (catalog discovery + multi-turn replay)
and stop an ordinary trusted comment from cancelling an active review.

## Decisions (approved)

- Scope: F04 + F05 + F06 in one sub-project (all remaining P1 findings).
- F04 discovery-failure policy: **advisory fail-open**. Only a successfully parsed
  catalog that lacks the model skips the LLM path; "can't tell" failures (404, other
  non-2xx, bad shape, timeout, network) warn and proceed to inference.
- No new action inputs. The discovery policy is not configurable; advisory is the default.
- Ship as `v0.5.0` (new behavior bundle): branch → PR → owner merge → tag `v0.5.0` →
  canary on tag → templates re-pin PR → move `v1`.
- Standing constraints hold: zero maintainer cost, BYOK-only, error-driven inference
  routing preserved (no model-name map), stable `pr-reviewer` technical namespace,
  opt-in agent stays read-only, no new dependencies, no autonomous writes/commits.

## 1. F04 — native model discovery

### Problem

`validateModelExists` (`src/providers.ts:223`) is the preflight for every LLM path. It
assumes one catalog shape (`data[].id`) and one auth scheme (Bearer, except a
Google-native `x-goog-api-key`). Consequences:

- **Native Google** (apiStyle `google-models`): `GET {apiRoot}/models` returns
  `{models:[{name:"models/..."}], nextPageToken?}` — no `data` array, so the parser
  throws and the whole LLM path is skipped.
- **Native Anthropic** (provider `anthropic`): `/models` requires `x-api-key` plus
  `anthropic-version` and paginates (`has_more`, `last_id`); the current Bearer auth
  401s → throw → skip. Even with auth fixed, pagination is ignored.
- Both failures are silent at the review level: the caller logs "slow path skipped"
  and produces no LLM review.

### Design

Separate **catalog protocol** from **inference protocol**. A new
`catalogProtocolFor(provider, apiStyle)` (`src/providers.ts`) returns
`"openai" | "anthropic" | "google"`, chosen from the endpoint being talked to, never
from the POST adapter. The protocol **owns its auth headers** — it supersedes
`authHeaderFor` (`src/providers.ts:206`), which returns only a header *name* and cannot
express the Anthropic two-header row. `authHeaderFor` and its pins
(`tests/providers.test.ts:323-333`) are retired in favor of the protocol table:

| `catalogProtocolFor` condition | Catalog | Auth headers | Shape | Pagination |
|---|---|---|---|---|
| apiStyle `google-models` and provider `google` or `custom` | `google` | `x-goog-api-key` | `models[].name` (`models/` prefix stripped) | `nextPageToken` → `?pageToken=` |
| provider `anthropic`, or provider `custom` with apiStyle `anthropic-messages` | `anthropic` | `x-api-key` + `anthropic-version: 2023-06-01` | `data[].id` | `has_more`/`last_id` → `?after_id=&limit=` |
| everything else (incl. `opencode-go`/`opencode-zen`, even when the POST adapter is google-models) | `openai` | `Authorization: Bearer` | `data[].id` | none |

The Anthropic row mirrors the Google row's `custom` clause because the Messages adapter
is itself `x-api-key`-native (`src/adapters/messages.ts:151`); a `custom` base with an
explicit `anthropic-messages` style speaks the Anthropic catalog. Zen/Go keep the
OpenAI-shaped catalog because their `/models` is the OpenCode catalog even when the POST
body is native Google (already documented on `authHeaderFor`).

Replace the boolean `validateModelExists` with a tri-state check:

```
checkModelListed(baseUrl, model, apiKey, protocol: "openai" | "anthropic" | "google")
  : Promise<"listed" | "absent" | "unknown">
```

- `listed`: 2xx, expected array present, model found (case-sensitive `id` equality;
  Google compares `name` after stripping the `models/` prefix).
- `absent`: 2xx, expected array present, model not found after bounded pagination (≤ 5 pages).
- `unknown`: 404, any other non-2xx, invalid JSON, missing/!array shape, timeout, or
  network error. **Never throws.**

Caller (`src/main.ts` slow-path preflight, `:520-535`):

- `absent` → warn `model "<id>" is not listed by the provider` and skip (unchanged).
- `unknown` → warn `model check inconclusive (<reason>); continuing` and **proceed**
  to inference (fail-open).
- `listed` → proceed.

This preserves discovery's value (a definitive miss still avoids a doomed call) while
never letting a discovery failure silently disable an otherwise-working adapter.
Error-driven inference routing is untouched: the probe still learns the working style
from real 400/404s on the POST.

Pagination is bounded (≤ 5 pages) and stops as soon as the model is found; each page
honors the existing `VALIDATE_TIMEOUT_MS` per request.

### Change sites

- `src/providers.ts`: add `catalogProtocolFor`; replace `validateModelExists` with
  `checkModelListed`; retire `authHeaderFor`.
- `src/main.ts`: the `Analysis` interface member (`:90`), the `realAnalysis` wiring
  (`:948`), and the preflight call (`:526`).
- Tests: `tests/providers.test.ts` (retire the `authHeaderFor`/`validateModelExists`
  pins; add the protocol/header/parse matrix), `tests/main.test.ts` (the four `Analysis`
  fakes at `:281`, `:436`, `:551`, `:1154`).

### Tests

Fixtures only (no live provider calls): Google-native `models[].name` match and miss;
Anthropic `data[].id` with `x-api-key`/`anthropic-version` and a multi-page `has_more`
walk that **asserts the exact `?after_id=` cursor** (not a server-agnostic fake that
echoes whatever the client sends); OpenAI `data[].id` unchanged; every `unknown` path
(404, 401, 500, invalid JSON, missing array, timeout) warns-and-proceeds; `absent`
skips; the header matrix (Bearer vs `x-goog-api-key` vs `x-api-key`+`anthropic-version`)
across `google`/`custom`/`anthropic`/`opencode-go` providers.

## 2. F05 — native assistant history replay

### Problem

`AssistantTurn.rawItems?: unknown[]` already exists and the Responses adapter echoes
native reply items verbatim. Google and Messages do not:

- `parseGoogleReply` (`src/adapters/google.ts`) returns only `text` plus neutral
  `toolCalls` with synthesized `fc_<index>` ids; `buildGoogleBody` reconstructs
  `role:"model"` parts from that, dropping `thoughtSignature` and native call ids.
  Gemini 3 requires function-call signatures returned in their original parts or the
  API rejects the turn.
- The Messages adapter likewise reconstructs assistant turns and drops opaque
  thinking/signature blocks.

### Design

Extend the existing `rawItems` seam to the other native adapters:

- **Google**: `parseGoogleReply` returns `rawItems` = the raw `candidate.content.parts`
  array (verbatim, including `thoughtSignature` and native ids). `buildGoogleBody`
  pushes those raw parts as the `role:"model"` content when `turn.rawItems !== undefined`,
  else reconstructs as today (mirrors `responses.ts`).
- **Messages**: same pattern — preserve raw assistant content blocks (thinking /
  signature) and replay them verbatim.
- **Tool-result role (Google)**: verify the documented contract for `functionResponse`
  parts. Today the adapter emits `role:"function"`; recent documented examples use
  `role:"user"`. Align with the documented native contract and pin it with a fixture.
  This is a compatibility correction, not a redesign; the signature loss is the
  primary defect.
- Single-shot `callGoogle` (no turns) is unaffected.

### Tests

Multi-turn replay fixtures asserting `thoughtSignature` and native call ids survive a
round trip (assistant turn → next request body) for Google and Messages; a Google
function-response role fixture pinning the chosen shape; existing single-shot tests
unchanged.

## 3. F06 — ordinary comments must not cancel an active review

### Problem

The workflow-level `concurrency` group (`pr-reviewer-<pr>`, `cancel-in-progress: true`)
is joined by **every** event for the PR, before any content check. A trusted author's
ordinary comment passes the job association gate, enters the group, cancels an
in-flight review, runs checkout/setup, and only then the action's `shouldTrigger` guard
rejects it as a non-review. The guard is correct but runs too late to prevent the
cancellation.

### Design

- Move `concurrency` from the workflow level to the `review` job. GitHub evaluates a
  job's `if` before the job starts and acquires job concurrency when the job starts, so
  a skipped job never joins the group (see the concurrency docs:
  https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).
  Non-review events therefore cannot cancel a running review; a superseded PR-head run
  still joins and cancels (unchanged).
- Mirror the action's `shouldTrigger` content predicate in the job `if:`
  (`src/github.ts:257`):
  - `issue_comment`: `github.event.issue.pull_request && contains(github.event.comment.body, '/review') && <trusted association>`.
  - `pull_request_review`: `<non-empty review body> && <trusted association>`.
  - `pull_request` / `workflow_dispatch`: unchanged.
- Keep the action's own guard (defense in depth; the workflow is a copy, the action
  stays the authority).

Scope: `docs/workflow-template.yml` only. The privileged template triggers on
`workflow_run` and has no comment path.

**Accepted divergence:** the action uses `reviewBody.trim() !== ""`; GitHub expressions
have no `trim`, so the workflow's review-body check is a plain non-empty test. A
whitespace-only submitted review body would still join the group — accepted as a
negligible edge (the primary F06 vector is comments).

### Tests

`tests/templates.test.ts` / `tests/ci.test.ts` assertions: concurrency is job-level
(not workflow-level); the job `if:` contains the `/review` content gate and the
non-empty review-body gate; actionlint on the template. A negative assertion that the
old workflow-level `concurrency:` block is gone. Because the YAML shape cannot prove
runtime cancellation, **the canary below is a required gate**, not optional.

### Canary (required)

On test-lupa: start a review (a `synchronize` push) and post an ordinary trusted comment
while it runs; confirm the review run is not cancelled and no review is posted for the
plain comment. Post `/review` and confirm it triggers.

## 4. Verification and release

- Gates per task: full `vitest`, `tsc --noEmit`, `npm run build && node --check dist/index.js`,
  actionlint on changed templates, non-triggering run exit 0.
- Canary (test-lupa, focused): F06 live as above (required). F04/F05 cannot be canaried
  live without real native provider keys; they are fixture-pinned. If a Google/Anthropic
  key is available, add an optional live check; otherwise record the limitation.
- Release order: branch `native-providers` → PR → owner merge → tag `v0.5.0` → canary
  on tag → templates re-pin PR → move `v1`.

## Out of scope

F07 (fallback summaries), F09 (gofmt drift), F10/F11 (whole-request budgets and agent
deadlines), F13 (read-tool coverage), F14 (fork/privileged publication policy), F15
(unbounded finding counts), Q01–Q04 (blocking/provenance policy), the measurement
harness, cross-scanner dedup, and the docs pass. No new inputs, no hosted components,
no autonomous writes.
