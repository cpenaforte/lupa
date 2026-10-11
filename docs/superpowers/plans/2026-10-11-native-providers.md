# Native provider protocols + review-trigger isolation (v0.5.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close F04 (native Google/Anthropic model discovery), F05 (native assistant-history replay), and F06 (an ordinary trusted comment cancelling an active review).

**Architecture:** Four small hardening changes in existing modules (no new files, no new deps): a protocol-aware, fail-open catalog check in `providers.ts`; the existing `rawItems` seam extended to the Google and Messages adapters; and job-level concurrency plus a content gate in the consumer template. Each task is independently committable and testable.

**Tech Stack:** TypeScript 5.x, Node >=24, vitest, esbuild (`dist/` committed), actionlint for the template task.

**Spec:** `docs/superpowers/specs/2026-10-11-native-providers-design.md`

## Global Constraints

- No new runtime dependencies (node builtins + existing deps only). `action.yml` is untouched (no new inputs). `PR_REVIEWER_*` env names, `pr-reviewer-*` concurrency/artifact strings, `pr-reviewer/1.0` user-agent, and `pr-reviewer:` log prefixes stay unchanged.
- Error-driven inference routing is preserved: no model-name map; the probe still learns the working style from real 400/404s on the POST.
- Every task that changes `src/` ends with `npm run build && node --check dist/index.js` and commits `dist/index.js`.
- Full suite (`npx vitest run`) green before every task commit; no test deleted without a replacement asserting the new contract.
- Commit messages use the exact strings given per task.
- Tasks 38–41 release together as `v0.5.0` (tagging itself is outside this plan; `docs/e2e-checklist.md` governs the release order).

## Review Focus

- **A discovery failure of any kind must never silently disable a working adapter.** 404, 5xx, invalid JSON, a missing/!array shape, an empty catalog, a timeout, or a network error must warn and proceed to inference; only a non-empty parsed catalog that genuinely lacks the model skips. Pin every path in Task 38.
- **Native catalogs must be genuinely readable.** Correct auth header(s), correct shape, and the exact pagination cursor (`after_id` for Anthropic, `pageToken` for Google). A server-agnostic fake that echoes the client's own parameter would hide a wrong cursor — assert the cursor string. Pin in Task 38.
- **Native assistant history must survive a round trip.** `thoughtSignature`, native call ids, and Anthropic thinking blocks are replayed verbatim on the next turn; losing them makes Gemini 3 turns fail. Pin in Tasks 39 and 40.
- **An ordinary trusted comment (no `/review`) must not cancel an active review**, while a `/review` comment and a PR `synchronize` still do. Pin in Task 41 (YAML shape) and the required canary (runtime).
- **Existing behavior preserved:** OpenAI-shaped catalogs (Zen/Go, Ollama), single-shot calls, and exact `toEqual` reply shapes. Pin in the owning tasks.

---

### Task 38: F04 — native model discovery (fail-open)

**Files:**
- Modify: `src/providers.ts` (add `catalogProtocolFor`; replace `validateModelExists` with `checkModelListed`; retire `authHeaderFor`)
- Modify: `src/main.ts` (import `:42`, `Analysis` interface `:90`, preflight `:520-535`, `realAnalysis` `:948`)
- Modify: `README.md` (model-check sentences at `:78` and `:95`)
- Test: `tests/providers.test.ts`, `tests/main.test.ts`

**Interfaces:**
- Produces: `export type CatalogProtocol = "openai" | "anthropic" | "google";`
- Produces: `export function catalogProtocolFor(provider: string, apiStyle: ResolvedApiStyle): CatalogProtocol`
- Produces: `export async function checkModelListed(baseUrl: string, model: string, apiKey: string, protocol: CatalogProtocol): Promise<{ status: "listed" | "absent" | "unknown"; detail?: string }>`
- Consumes: `ResolvedApiStyle` (existing, `src/providers.ts`).

**Exact behavior:**
- `catalogProtocolFor`: `"google"` when `apiStyle === "google-models"` and provider is `google` or `custom`; else `"anthropic"` when provider is `anthropic`, or provider `custom` with `apiStyle === "anthropic-messages"`; else `"openai"`.
- Headers (always include `User-Agent: pr-reviewer/1.0`): `google` → `x-goog-api-key`; `anthropic` → `x-api-key` + `anthropic-version: 2023-06-01`; `openai` → `Authorization: Bearer <key>`.
- Requests / parse / pagination (≤ 5 pages; `VALIDATE_TIMEOUT_MS` per request):
  - `google`: `GET {base}/models?pageSize=1000`; match `models[].name` after stripping the `models/` prefix; next via `nextPageToken` → `?pageToken=<token>&pageSize=1000`.
  - `anthropic`: `GET {base}/models?limit=1000`; match `data[].id`; next via `has_more === true` and a non-empty `last_id` → `?after_id=<last_id>&limit=1000`.
  - `openai`: `GET {base}/models`; match `data[].id`; no pagination.
- Result: found → `listed`; not found but ≥ 1 page returned a non-empty array → `absent`; otherwise (404, other non-2xx, invalid JSON, missing/!array shape, all pages empty, timeout, network) → `unknown` with a short `detail`. **Never throws.**

- [ ] **Step 1: Write the failing tests in `tests/providers.test.ts`**

Replace the existing `authHeaderFor` pins (`:323-334`) and the `validateModelExists` pins (`:305-349`) with:

```ts
it("catalogProtocolFor maps provider + style to the catalog protocol", () => {
  expect(catalogProtocolFor("google", "google-models")).toBe("google");
  expect(catalogProtocolFor("custom", "google-models")).toBe("google");
  expect(catalogProtocolFor("anthropic", "anthropic-messages")).toBe("anthropic");
  expect(catalogProtocolFor("custom", "anthropic-messages")).toBe("anthropic");
  expect(catalogProtocolFor("opencode-go", "google-models")).toBe("openai");
  expect(catalogProtocolFor("opencode-zen", "openai-chat")).toBe("openai");
  expect(catalogProtocolFor("ollama", "openai-chat")).toBe("openai");
});

it("checkModelListed reads a google-native models[].name catalog and follows pageToken", async () => {
  const urls: string[] = [];
  const fetchMock = vi.fn(async (u: string) => {
    urls.push(u);
    return urls.length === 1
      ? new Response(JSON.stringify({ models: [{ name: "models/other" }], nextPageToken: "t" }), { status: 200 })
      : new Response(JSON.stringify({ models: [{ name: "models/wanted" }] }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  expect(await checkModelListed("https://g/v1beta", "wanted", "K", "google")).toEqual({ status: "listed" });
  expect(urls[1]).toBe("https://g/v1beta/models?pageToken=t&pageSize=1000");
  const h = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
  expect(h["x-goog-api-key"]).toBe("K");
  expect(h.Authorization).toBeUndefined();
});

it("checkModelListed sends x-api-key + anthropic-version and follows after_id", async () => {
  const urls: string[] = [];
  const fetchMock = vi.fn(async (u: string) => {
    urls.push(u);
    return urls.length === 1
      ? new Response(JSON.stringify({ data: [{ id: "other" }], has_more: true, last_id: "other" }), { status: 200 })
      : new Response(JSON.stringify({ data: [{ id: "wanted" }], has_more: false }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  expect(await checkModelListed("https://a/v1", "wanted", "K", "anthropic")).toEqual({ status: "listed" });
  expect(urls[1]).toBe("https://a/v1/models?after_id=other&limit=1000");
  const h = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
  expect(h["x-api-key"]).toBe("K");
  expect(h["anthropic-version"]).toBe("2023-06-01");
  expect(h.Authorization).toBeUndefined();
});

it("checkModelListed reads an OpenAI data[].id catalog with Bearer", async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "m" }] }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  expect(await checkModelListed("https://o/v1", "m", "K", "openai")).toEqual({ status: "listed" });
  const h = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
  expect(h.Authorization).toBe("Bearer K");
});

it("checkModelListed returns absent only for a non-empty catalog missing the model", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "other" }] }), { status: 200 })));
  expect(await checkModelListed("https://o/v1", "wanted", "K", "openai")).toEqual({ status: "absent" });
});

it("checkModelListed returns unknown (never throws) for 404, 500, invalid JSON, missing array, empty array, timeout", async () => {
  const cases: Array<() => Response | Promise<Response>> = [
    () => new Response("nope", { status: 404 }),
    () => new Response("boom", { status: 500 }),
    () => new Response("{not json", { status: 200 }),
    () => new Response(JSON.stringify({ nope: [] }), { status: 200 }),
    () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
  ];
  for (const c of cases) {
    vi.stubGlobal("fetch", vi.fn(async () => c()));
    expect((await checkModelListed("https://o/v1", "m", "K", "openai")).status).toBe("unknown");
  }
  // Timeout: the request rejects on abort, as a real fetch does.
  vi.stubGlobal("fetch", vi.fn((_u: string, init?: RequestInit) =>
    new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")))),
  ));
  vi.useFakeTimers();
  const p = checkModelListed("https://o/v1", "m", "K", "openai");
  await vi.advanceTimersByTimeAsync(15_000);
  expect((await p).status).toBe("unknown");
  vi.useRealTimers();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/providers.test.ts`
Expected: FAIL (`catalogProtocolFor`/`checkModelListed` not defined).

- [ ] **Step 3: Implement in `src/providers.ts`**

Add `CatalogProtocol`, `catalogProtocolFor`, and `checkModelListed` per the Exact behavior. A small private `catalogHeaders(protocol, apiKey)` builds the header set. Delete `authHeaderFor` and `validateModelExists`. Reuse the existing `VALIDATE_TIMEOUT_MS` and `USER_AGENT` constants.

- [ ] **Step 4: Rewire `src/main.ts`**

- Import (`:42`): drop `authHeaderFor`/`validateModelExists`, add `catalogProtocolFor`/`checkModelListed`.
- `Analysis` interface (`:90`): replace the `validateModelExists` member with `checkModelListed(baseUrl: string, model: string, apiKey: string, protocol: CatalogProtocol): Promise<{ status: "listed" | "absent" | "unknown"; detail?: string }>`.
- `realAnalysis` (`:948`): `checkModelListed,`.
- Preflight (`:520-535`): replace the try/catch with:

```ts
const check = await deps.analysis.checkModelListed(
  ep.baseUrl, i.llmModel, i.llmApiKey, catalogProtocolFor(i.llmProvider, ep.apiStyle),
);
if (check.status === "absent") {
  core.warning(`slow path skipped: model "${i.llmModel}" is not listed by the provider`);
  return undefined;
}
if (check.status === "unknown") {
  core.warning(`model check inconclusive (${check.detail ?? "unknown error"}); continuing`);
}
```

- [ ] **Step 5: Update `tests/main.test.ts`**

- `MockOpts` (`:195`): replace `validateModel?: boolean | "reject"` with `modelCheck?: "listed" | "absent" | "unknown"`.
- The four `Analysis` fakes (`:281`, `:436`, `:551`, `:1154`): replace `validateModelExists: async (_b,_m,_k, auth) => { rec.validateAuth = auth; ... }` with `checkModelListed: async (_b,_m,_k, protocol) => { rec.modelProtocol = protocol; return { status: o.modelCheck ?? "listed" }; }` (rename the recorder field `validateAuth` → `modelProtocol`; grep `validateAuth` for assertions).
- Rewrite the `:513` test: a `modelCheck: "unknown"` run must **proceed** (`llmCalled > 0`, `findingsFrom` not `"fastpath"`); add `it("an absent model skips the slow path with a warning but still posts fast-path")` for `modelCheck: "absent"` (`slowPathSkipped` true, `llmCalled` 0).
- Any test using `validateModel: false` → `modelCheck: "absent"`; `validateModel: "reject"` → `modelCheck: "unknown"`.

- [ ] **Step 6: Update `README.md`**

At `:78` and `:95`, state the advisory policy: the check reads the provider catalog (native Google/Anthropic shapes included) and is advisory — a definitive miss skips the LLM path, but an inconclusive check warns and continues to inference.

- [ ] **Step 7: Run tests + build**

Run: `npx vitest run tests/providers.test.ts tests/main.test.ts && npx vitest run && npm run build && node --check dist/index.js`
Expected: PASS all green; build clean.

- [ ] **Step 8: Commit**

```bash
git add src/providers.ts src/main.ts tests/providers.test.ts tests/main.test.ts README.md dist/index.js
git commit -m "fix: native model discovery with advisory fail-open (F04)"
```

---

### Task 39: F05 — replay native Google assistant history

**Files:**
- Modify: `src/adapters/google.ts` (`parseGoogleReply`, `buildGoogleBody`, `callGoogleTurn`)
- Test: `tests/adapters-google.test.ts`

**Interfaces:**
- Produces: `GoogleReply`'s ok-true variant gains `rawItems: unknown[]`.
- Produces: `callGoogleTurn` returns `{ ok: true; text: string; toolCalls: ToolCall[]; rawItems: unknown[] }` (already assignable to `AgentReply`, whose `rawItems?: unknown[]` exists).
- Consumes: `AssistantTurn.rawItems?: unknown[]` (`src/agent-types.ts`; `agent.ts:123-129` already forwards it).

**Exact behavior:**
- `parseGoogleReply` returns `rawItems` = the raw `candidate.content.parts` array when it is an array, else `[]`.
- `buildGoogleBody`: an assistant turn with `turn.rawItems !== undefined` pushes those raw parts verbatim as the `role:"model"` content (no text/toolCall reconstruction); otherwise reconstruct as today. Tool-result turns use `role:"user"` (was `"function"`).
- `callGoogle` (single-shot) ignores `rawItems`; its behavior is unchanged.

- [ ] **Step 1: Write the failing tests in `tests/adapters-google.test.ts`**

```ts
it("replays assistant rawItems (thoughtSignature + native ids) verbatim", async () => {
  const c: Conversation = {
    system: "s", user: "u",
    turns: [{
      role: "assistant", text: "t",
      toolCalls: [{ id: "fc_0", name: "read_file", args: { path: "a.ts" }, rawArgs: '{"path":"a.ts"}' }],
      rawItems: [{ text: "t", thoughtSignature: "sig-123" }, { functionCall: { id: "native-1", name: "read_file", args: { path: "a.ts" } } }],
    }],
    tools: [toolDef],
  };
  await callGoogleTurn(fakeGoogleEp(), MODEL, c, opts(), turnFlags);
  expect(lastBody().contents).toEqual([
    { role: "user", parts: [{ text: "u" }] },
    { role: "model", parts: [{ text: "t", thoughtSignature: "sig-123" }, { functionCall: { id: "native-1", name: "read_file", args: { path: "a.ts" } } }] },
  ]);
});
```

Update the existing test at `:307` (functionResponse parts use `role:"user"`) and the exact reply shape at `:363` (add the `rawItems` the reply now carries).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/adapters-google.test.ts`
Expected: FAIL (no `rawItems`; still `role:"function"`).

- [ ] **Step 3: Implement in `src/adapters/google.ts`**

Add `rawItems` to the ok-true `GoogleReply`; capture it in `parseGoogleReply`; echo `turn.rawItems` in `buildGoogleBody` when present; switch the tool-result role to `"user"`; return `rawItems` from `callGoogleTurn`.

- [ ] **Step 4: Run tests + build**

Run: `npx vitest run tests/adapters-google.test.ts && npx vitest run && npm run build && node --check dist/index.js`
Expected: PASS all green; build clean.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/google.ts tests/adapters-google.test.ts dist/index.js
git commit -m "fix: replay native Google assistant history (F05)"
```

---

### Task 40: F05 — replay native Messages assistant history

**Files:**
- Modify: `src/adapters/messages.ts` (`parseMessagesReply`, `buildMessagesBody`, `callMessagesTurn`)
- Test: `tests/adapters-messages.test.ts`

**Interfaces:**
- Produces: `MessagesReply`'s ok-true variant gains `rawItems: unknown[]`.
- Produces: `callMessagesTurn` returns `{ ok: true; text: string; toolCalls: ToolCall[]; rawItems: unknown[] }`.
- Consumes: `AssistantTurn.rawItems?` (as Task 39).

**Exact behavior:**
- `parseMessagesReply` returns `rawItems` = the raw `content[]` array when it is an array, else `[]`.
- `buildMessagesBody`: an assistant turn with `turn.rawItems !== undefined` pushes `{ role: "assistant", content: turn.rawItems }` verbatim (no text/tool_use reconstruction); otherwise reconstruct as today.
- `callMessages` (single-shot) ignores `rawItems`; its behavior is unchanged.

- [ ] **Step 1: Write the failing test in `tests/adapters-messages.test.ts`**

```ts
it("replays assistant rawItems (thinking block with signature) verbatim", async () => {
  const c: Conversation = {
    system: "s", user: "u",
    turns: [{
      role: "assistant", text: "t",
      toolCalls: [{ id: "t1", name: "read_file", args: {}, rawArgs: "{}" }],
      rawItems: [{ type: "thinking", thinking: "hmm", signature: "sig-123" }, { type: "tool_use", id: "t1", name: "read_file", input: {} }],
    }],
    tools: [toolDef],
  };
  await callMessagesTurn(fakeMessagesEp(), c, turnOpts(), toolFlags);
  expect(lastBody().messages).toEqual([
    { role: "user", content: "u" },
    { role: "assistant", content: [{ type: "thinking", thinking: "hmm", signature: "sig-123" }, { type: "tool_use", id: "t1", name: "read_file", input: {} }] },
  ]);
});
```

If any existing success-path `toEqual` on `callMessagesTurn` breaks from the added `rawItems`, update it to include the raw content array (do not delete the assertion).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/adapters-messages.test.ts`
Expected: FAIL (no `rawItems`; thinking block dropped).

- [ ] **Step 3: Implement in `src/adapters/messages.ts`**

Add `rawItems` to the ok-true `MessagesReply`; capture it in `parseMessagesReply`; echo `turn.rawItems` in `buildMessagesBody` when present; return `rawItems` from `callMessagesTurn`.

- [ ] **Step 4: Run tests + build**

Run: `npx vitest run tests/adapters-messages.test.ts && npx vitest run && npm run build && node --check dist/index.js`
Expected: PASS all green; build clean.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/messages.ts tests/adapters-messages.test.ts dist/index.js
git commit -m "fix: replay native Messages assistant history (F05)"
```

---

### Task 41: F06 — ordinary comments must not cancel an active review

**Files:**
- Modify: `docs/workflow-template.yml` (move `concurrency` to the `review` job; add the content gate to its `if:`)
- Test: `tests/templates.test.ts`

**Interfaces:** none (YAML + text assertions only).

**Exact behavior:**
- No workflow-level `concurrency:` block (before `jobs:`).
- The `review` job owns `concurrency:` with `cancel-in-progress: true` and the existing group expression.
- The `review` job `if:` adds, for `issue_comment`, `github.event.issue.pull_request && contains(github.event.comment.body, '/review')`, and for `pull_request_review`, `github.event.review.body != ''` — mirroring `shouldTrigger` (`src/github.ts:257`).

- [ ] **Step 1: Write the failing test in `tests/templates.test.ts`**

```ts
it("moves concurrency to the review job and gates non-review comments", () => {
  const t = fs.readFileSync("docs/workflow-template.yml", "utf8");
  expect(t.slice(0, t.indexOf("jobs:"))).not.toContain("concurrency:");
  const job = t.slice(t.indexOf("  review:"));
  expect(job).toContain("concurrency:");
  expect(job).toContain("cancel-in-progress: true");
  expect(t).toContain("contains(github.event.comment.body, '/review')");
  expect(t).toContain("github.event.review.body != ''");
});
```

Also update the SARIF-permissions slice at `:161`: change `t.indexOf("concurrency:")` to `t.indexOf("jobs:")` (the workflow-level block it bounded is gone).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/templates.test.ts`
Expected: FAIL (workflow-level `concurrency:` still present; no content gate).

- [ ] **Step 3: Edit `docs/workflow-template.yml`**

Delete the workflow-level `concurrency:` block (lines 45-47). On the `review` job, after the existing `if:` (extend it) add:

```yaml
    if: >-
      (github.event_name != 'issue_comment' || (github.event.issue.pull_request && contains(github.event.comment.body, '/review') && contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.comment.author_association)))
      && (github.event_name != 'pull_request_review' || (github.event.review.body != '' && contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.review.author_association)))
    concurrency:
      group: pr-reviewer-${{ github.event.pull_request.number || github.event.issue.number || inputs.pr_number }}
      cancel-in-progress: true
```

- [ ] **Step 4: Run tests + actionlint**

Run: `npx vitest run tests/templates.test.ts tests/ci.test.ts && npx vitest run`
Then actionlint (same invocation CI uses):
`"$RUNNER_TEMP/actionlint" .github/workflows/ci.yml docs/workflow-template.yml docs/workflow-template-privileged.yml` — locally, download v1.7.12 as `ci.yml` does and run it on the two templates.
Expected: PASS; actionlint exit 0.

- [ ] **Step 5: Commit**

```bash
git add docs/workflow-template.yml tests/templates.test.ts
git commit -m "fix: isolate review-trigger concurrency from ordinary comments (F06)"
```

---

## Verification and release (outside the tasks)

- Whole-branch review after all four tasks, then branch `native-providers` → PR → owner merge.
- Release order (`docs/e2e-checklist.md`): tag `v0.5.0` → canary on the tag → templates re-pin PR → move `v1`.
- **Required canary (F06):** on test-lupa, start a review (a `synchronize` push) and post an ordinary trusted comment while it runs — the review run must not be cancelled and no review is posted for the plain comment; a `/review` comment must trigger.
- F04/F05 are fixture-pinned (no live native provider keys in the canary); record that limitation.
