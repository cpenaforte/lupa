# Trust boundaries (v0.4.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the five Codex trust-boundary findings (F01 template venv shadowing, F02 credential redaction ordering, F03 stale-head relabeling, F08 failed scans looking clean, F12 linked-clone cache trust) with tests pinning each behavior.

**Architecture:** Four small hardening changes in the existing modules (no new files, no new deps): template cwd fix, `redactFindings` applied at the three artifact writes, stale-422 converted from re-resolve-and-retry to typed skip, SARIF invocation-health check in `fromStdout`, clone-marker validation in `ensureLinkedRepo`. Each task is independently committable and testable.

**Tech Stack:** TypeScript 5.x, Node >=24, vitest, esbuild (`dist/` committed), actionlint for the template task.

**Spec:** `docs/superpowers/specs/2026-10-11-trust-boundaries-design.md`

## Global Constraints

- `dist/index.js` is committed: every task that changes `src/` ends with `npm run build && node --check dist/index.js` and commits `dist/index.js`. Verify with `git diff --exit-code` workflow parity (build must be clean).
- Full suite (`npx vitest run`) green before every task commit; no new runtime dependencies (node builtins + existing deps only).
- `action.yml` is untouched (no new inputs). `PR_REVIEWER_*` env names, `pr-reviewer-*` concurrency/artifact strings, `pr-reviewer/1.0` user-agent, and `pr-reviewer:` log prefixes are stable and unchanged.
- Existing tests that pin superseded behavior are updated inside the task that supersedes them (named per task). No test may be deleted without a replacement asserting the new contract.
- Task 33 (template-only) merges with no version tag. Tasks 34–37 release together as `v0.4.0` (tagging itself is outside this plan; the release procedure in `docs/e2e-checklist.md` governs).
- Commit messages use the exact strings given per task.

## Review Focus

- An LLM-sourced finding echoing the runtime key must be masked in the merged `findings.json`, in `sarif.json`, and in the posted body — not just fast-path echoes. A reasonable person expects every persistence boundary masked. Test in Task 34's step style.
- A stale-commit 422 on the Flow B (`workflow_run`) path must skip posting with the same note, not post stale evidence. A reasonable person expects both flows to share the no-relabel rule. Test in Task 35's step style.
- SARIF with `executionSuccessful: false` AND real results must yield the warning *plus* the findings (partial path keeps signal). A reasonable person expects failure disclosure without losing usable results. Test in Task 36's step style.
- A clone dir whose marker is valid but whose `.git` is corrupt (`git rev-parse` fails) must fail closed to wipe-and-reclone, never throw to the tool caller. A reasonable person expects the cache to distrust itself. Test in Task 37's step style.
- Redacted `sarif.json` must still parse as JSON with `version: "2.1.0"`. A reasonable person expects masking to never corrupt the artifact. Test in Task 34's step style.

---

### Task 33: F01 — semgrep setup runs outside the PR checkout

**Files:**
- Modify: `docs/workflow-template.yml` (Install semgrep step only)
- Test: `tests/templates.test.ts` (extend the semgrep test at line ~88)

**Interfaces:**
- Consumes: nothing.
- Produces: Install semgrep step with `working-directory: ${{ runner.temp }}` and venv at `$RUNNER_TEMP/lupa-semgrep-venv` (all three path references: `python3 -m venv`, `pip install`, `GITHUB_PATH` echo).

- [ ] **Step 1: Write the failing test**

```ts
it("semgrep setup runs with cwd outside the PR checkout", () => {
  const t = fs.readFileSync("docs/workflow-template.yml", "utf8");
  expect(t).toContain("working-directory: ${{ runner.temp }}");
  expect(t).toContain("$RUNNER_TEMP/lupa-semgrep-venv");
  expect(t).not.toContain("$RUNNER_TEMP/semgrep-venv");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/templates.test.ts`
Expected: FAIL on the new test (no `working-directory`, old venv path present).

- [ ] **Step 3: Edit the Install semgrep step in `docs/workflow-template.yml`**

Add `working-directory: ${{ runner.temp }}` to the step; rename all three
`$RUNNER_TEMP/semgrep-venv` references to `$RUNNER_TEMP/lupa-semgrep-venv`.
Checkout/diff steps do not move. Privileged template untouched (no Python setup).

- [ ] **Step 4: Run tests + actionlint to verify they pass**

Run: `npx vitest run tests/templates.test.ts tests/ci.test.ts` then full `npx vitest run`
Expected: PASS. Then actionlint on `docs/workflow-template.yml` (same invocation CI uses).
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add docs/workflow-template.yml tests/templates.test.ts
git commit -m "fix: run semgrep setup outside the PR checkout (F01)"
```

---

### Task 34: F02 — redact runtime keys at every artifact write

**Files:**
- Modify: `src/main.ts` (three write sites + one helper)
- Test: `tests/main.test.ts` (extend run() fixtures)

**Interfaces:**
- Consumes: `redactFindings(findings, secrets)` from `src/review.ts` (exists; returns new objects, never mutates).
- Produces: module-private `runtimeSecrets(env: RunEnv): string[]` in `src/main.ts` returning `[env.inputs.githubToken, env.inputs.llmApiKey].filter(s => s !== "")`; used at all three writes below (replacing the inline expression at the publish site).

- [ ] **Step 1: Write the failing tests**

```ts
it("fast findings echoing the token are masked in the early findings.json", async () => {
  // run() fixture with githubToken "tok-live-123", a fast finding whose message
  // contains "tok-live-123", non-triggering-safe assertions on the artifact dir:
  const raw = readFileSync(join(artifactDir, "findings.json"), "utf8");
  expect(raw).not.toContain("tok-live-123");
  expect(raw).toContain("[REDACTED]");
});
it("merged findings and sarif.json are masked and sarif stays valid", async () => {
  // run() fixture with llmApiKey "key-live-456" echoed in an LLM-sourced finding:
  const sarif = JSON.parse(readFileSync(join(artifactDir, "sarif.json"), "utf8"));
  expect(sarif.version).toBe("2.1.0");
  expect(JSON.stringify(sarif)).not.toContain("key-live-456");
});
```

Follow the existing `runWithMocks`-style fixture pattern in `tests/main.test.ts`
(scratch dirs, fake Deps/Gateway); drive through `run()`, assert on artifact files.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/main.test.ts`
Expected: FAIL (raw keys present in artifacts).

- [ ] **Step 3: Implement redaction at the three write sites in `src/main.ts`**

Wrap each write's payload with `redactFindings(payload, runtimeSecrets(env))`
without mutating the in-memory arrays (prompt building and analysis keep seeing
the originals):
1. early `writeFindings` after fast-path (line ~788),
2. merged `writeFindings` (line ~806),
3. the `sarif.json` write (line ~807, redact `all` before `toSarif`).
Replace the inline secrets expression at the publish site (line ~637) with
`runtimeSecrets(env)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/main.test.ts && npx vitest run && npm run build && node --check dist/index.js`
Expected: PASS all green; build clean.

- [ ] **Step 5: Commit**

```bash
git add src/main.ts tests/main.test.ts dist/index.js
git commit -m "fix: redact runtime keys at every artifact write (F02)"
```

---

### Task 35: F03 — stale head skips instead of relabeling

**Files:**
- Modify: `src/github.ts` (`postReview` stale branch + result type + doc comments), `src/main.ts` (`publishReview` catch)
- Test: `tests/github.test.ts` (rewrite stale-path tests), `tests/main.test.ts` (skip-note test)

**Interfaces:**
- Consumes: `STALE_SHA` classifier, `OFF_DIFF` classifier in `src/github.ts` (unchanged).
- Produces: `export class StaleHeadError extends Error { analyzedSha: string; liveSha: string }` from `src/github.ts`; `postReview` throws it on the first stale-commit 422 (after learning `liveSha` via the existing `pulls.get` call, which stays); the re-resolve-and-retry branch is removed. `PostReviewResult` drops `retriedWithNewSha`. `publishReview` catches `StaleHeadError` and calls `note(env, out, ...)` with the exact string below, posts nothing, exit 0. Both flows (A and B) share `publishReview`, so both are covered.

Exact skip note: `` `pr-reviewer: PR head moved during posting; analyzed ${analyzedSha}, live ${liveSha}; skipping review for the stale head.` ``

- [ ] **Step 1: Write the failing tests**

```ts
// tests/github.test.ts
it("stale commit_id 422 throws StaleHeadError with both SHAs and makes no second POST", async () => {
  // fake octokit: first createReview rejects 422 stale, pulls.get returns live sha;
  // assert the throw is StaleHeadError with analyzedSha/liveSha set, and createReview ran once.
});
```

```ts
// tests/main.test.ts
it("stale head during posting skips the review with a note and exit 0", async () => {
  // run() fixture whose fake Gateway postReview throws StaleHeadError-like path;
  // assert no review posted, summary contains "skipping review for the stale head", exit 0.
});
it("stale head on the Flow B path skips with the same note", async () => {
  // workflow_run fixture reaching publishReview with a stale 422; same assertions.
});
```

Update the eight tests pinning the old contract
(`tests/github.test.ts:70,175,245,279,286,293,300,309,316`) to the new one:
no re-resolve-and-retry; single POST attempt on the stale path. Update the doc
comments at `src/github.ts:26,124,126` (remove re-resolve language, state skip).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/github.test.ts tests/main.test.ts`
Expected: FAIL (old retry behavior / missing StaleHeadError).

- [ ] **Step 3: Implement the stale-skip in `src/github.ts` + `src/main.ts`**

In `postReview`: on `STALE_SHA` match, keep the `pulls.get` live-sha lookup
(unchanged error mapping), then `throw new StaleHeadError(commitId, head)`
instead of retrying. In `publishReview`: catch `StaleHeadError`, emit the exact
skip note via `note()`, return without posting (exit code stays 0).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/github.test.ts tests/main.test.ts && npx vitest run && npm run build && node --check dist/index.js`
Expected: PASS all green; build clean.

- [ ] **Step 5: Commit**

```bash
git add src/github.ts src/main.ts tests/github.test.ts tests/main.test.ts dist/index.js
git commit -m "fix: skip (never relabel) on stale PR head (F03)"
```

---

### Task 36: F08 — failed scanner invocations emit warning findings

**Files:**
- Modify: `src/scanners.ts` (`fromStdout` + the file-report SARIF path if it shares the shape)
- Test: `tests/scanners.test.ts` (extend)

**Interfaces:**
- Consumes: `parseSarif(text)` (exists), `warning(rule, message)` helper (exists; check its exact name/signature in `src/scanners.ts` before use).
- Produces: unchanged `fromStdout(tool, label, r, timeoutMs?)` signature; when parsed SARIF is present AND (`runs[].invocations[]` has `executionSuccessful === false` OR any `toolExecutionNotifications[]` with `level: "error"`), the returned array is `[...parsed, warning("scanner-failed", ...)]` with the exact message `` `${label} reported an unsuccessful run` ``.

- [ ] **Step 1: Write the failing tests**

```ts
it("exit-2 SARIF with executionSuccessful:false and an error notification yields exactly one scanner-failed warning", () => {
  // fromStdout("semgrep", "semgrep", { code: 2, stdout: <valid SARIF, zero results,
  //   invocations: [{ executionSuccessful: false, toolExecutionNotifications: [{ level: "error", message: { text: "boom" } }] }]>, ... })
  // expect(result).toHaveLength(1); expect(result[0]).toMatchObject({ rule: "scanner-failed" });
});
it("unsuccessful run WITH results keeps the findings and appends the warning", () => {
  // same shape but one real result in runs[0].results;
  // expect findings present AND the trailing scanner-failed warning.
});
it("exit-1 with clean successful SARIF stays quiet (findings codes keep meaning)", () => {
  // code 1, executionSuccessful true/absent, one result → findings only, no warning.
});
```

Check the `Exec` type fields (`missing`, `timedOut`, `code`, `stdout`) in `src/scanners.ts` and construct fakes accordingly.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/scanners.test.ts`
Expected: FAIL (no warning appended).

- [ ] **Step 3: Implement invocation-health check in `fromStdout`**

After successful `parseSarif`, walk `runs[].invocations[]`; on
`executionSuccessful === false` or any error-level
`toolExecutionNotifications` entry, append the exact warning above. Apply the
same check to the file-report SARIF path (line ~380) if it parses the same
`runs` shape; otherwise note in the report why it is out of scope.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/scanners.test.ts && npx vitest run && npm run build && node --check dist/index.js`
Expected: PASS all green; build clean.

- [ ] **Step 5: Commit**

```bash
git add src/scanners.ts tests/scanners.test.ts dist/index.js
git commit -m "fix: failed scanner invocations emit warning findings (F08)"
```

---

### Task 37: F12 — validate linked-clone cache before reuse

**Files:**
- Modify: `src/linked-repos.ts` (marker + validation), `src/main.ts` (log the SHA)
- Test: `tests/linked-repos.test.ts` (extend), `tests/main.test.ts` (SHA log test)

**Interfaces:**
- Consumes: `CloneDeps.run` test seam (exists; reuse for git introspection with `cwd` set to the clone dir and `{ ...process.env, GIT_TERMINAL_PROMPT: "0" }` env, no token vars), existing `removeDir` helper (exists).
- Produces: `ensureLinkedRepo` writes `.lupa-clone.json` (`{repo, branch, sha}`) next to the clone after a successful fresh clone (post-size-walk); on an existing dir it validates before returning — `.git` present, marker parses with matching `repo`, `git config --get remote.origin.url` equals `https://github.com/${alias}.git`, `git rev-parse --abbrev-ref HEAD` equals marker branch, size walk within `maxBytes` (skipped when `maxBytes` is undefined). Any mismatch or git error → wipe (marker included) and run the full fresh-clone path. Success returns `{ dir: string; sha: string }` (sha now required; update fake results in `tests/linked-repos.test.ts` and `tests/main.test.ts` that construct `{ dir }` literals). `main.ts` `ensureLinked` closure logs the exact string `` `agent linked repo ${alias} at ${sha}` `` whenever `sha` is present.

- [ ] **Step 1: Write the failing tests**

```ts
it("re-clones when the cached dir is not a git repo", ...); // plain dir at destination → deps.run sees a fresh clone argv
it("re-clones on origin mismatch", ...); // marker repo "a/b", git config returns another URL → clone
it("re-clones when rev-parse fails (corrupt .git) without throwing", ...); // run fake rejects on rev-parse → caller gets a fresh {dir} (no throw)
it("reuses a valid cache with zero git-mutating calls and returns its sha", ...); // run fake records argv; assert no clone argv; sha equals rev-parse HEAD output
it("skips the size check when maxBytes is undefined", ...);
```

```ts
// tests/main.test.ts
it("logs the linked repo SHA on reuse", ...); // agent fixture; assert log contains "agent linked repo someone/else at "
```

Check how `core.info` is asserted in existing agent tests before writing the log test.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/linked-repos.test.ts tests/main.test.ts`
Expected: FAIL (no marker/validation; `{dir}`-only fakes).

- [ ] **Step 3: Implement marker + validation in `src/linked-repos.ts`, SHA log in `src/main.ts`**

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/linked-repos.test.ts tests/main.test.ts && npx vitest run && npm run build && node --check dist/index.js`
Expected: PASS all green; build clean.

- [ ] **Step 5: Commit**

```bash
git add src/linked-repos.ts src/main.ts tests/linked-repos.test.ts tests/main.test.ts dist/index.js
git commit -m "fix: validate linked-clone cache before reuse (F12)"
```
