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
Also update the existing pin at `tests/templates.test.ts:93`
(`echo "$RUNNER_TEMP/semgrep-venv/bin" >> "$GITHUB_PATH"`) to the new venv path —
it asserts the old string and would otherwise fail.

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
- Modify: `src/main.ts` (three write sites + one helper), `README.md` (redaction non-goal note), `tests/readme.test.ts` (pin it)
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
`runtimeSecrets(env)`, and put a code comment on `runtimeSecrets` stating the
non-goal: runtime-key masking only; secrets committed in the diff are a separate
scanner concern and are not covered. Add the same two clauses to `README.md` in a
short redaction subsection, pinned by `tests/readme.test.ts`:

```ts
it("documents runtime-key masking scope", () => {
  const r = fs.readFileSync("README.md", "utf8");
  expect(r).toContain("runtime-key masking only");
  expect(r).toContain("separate scanner concern");
});
```

Use those exact clause strings in both the comment and the README so the pin holds.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/main.test.ts && npx vitest run && npm run build && node --check dist/index.js`
Expected: PASS all green; build clean.

- [ ] **Step 5: Commit**

```bash
git add src/main.ts tests/main.test.ts README.md tests/readme.test.ts dist/index.js
git commit -m "fix: redact runtime keys at every artifact write (F02)"
```

---

### Task 35: F03 — stale head skips instead of relabeling

**Files:**
- Modify: `src/github.ts` (`postReview` stale branch + result type + doc comments), `src/main.ts` (`publishReview` catch)
- Test: `tests/github.test.ts` (rewrite stale-path tests), `tests/main.test.ts` (skip-note test)

**Interfaces:**
- Consumes: `STALE_SHA` classifier, `OFF_DIFF` classifier in `src/github.ts` (unchanged).
- Produces: `export class StaleHeadError extends Error { analyzedSha: string; liveSha: string }` from `src/github.ts`; `postReview` throws it on the first stale-commit 422 (after learning `liveSha` via the existing `pulls.get` call, which stays); the re-resolve-and-retry branch is removed. `PostReviewResult` drops `retriedWithNewSha`. `publishReview` catches `StaleHeadError` and calls `note(env, out, ...)` with the exact string below, posts nothing, and sets a new optional `staleSkipped?: boolean` flag on the outcome plus `out.exitCode = 0`. Both flow callers (`runFlowA`, `runFlowB`) skip their unconditional `out.exitCode = exitFor(...)` overwrite when `out.staleSkipped` is set — otherwise the default warning gate would exit 2 on the skipped run. Both flows (A and B) share `publishReview`, so both are covered.

Exact skip note: `` `pr-reviewer: PR head moved during posting; analyzed ${analyzedSha}, live ${liveSha}; skipping review for the stale head — a fresh run will cover the new head.` ``

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
  // run() fixture (fail_level warning, warning-severity findings present) whose fake
  // Gateway postReview path throws StaleHeadError; assert no review posted, summary
  // contains "skipping review for the stale head", and exit code is 0 (not 2).
});
it("stale head on the Flow B path skips with the same note", async () => {
  // workflow_run fixture reaching publishReview with a stale 422; same assertions.
});
```

Update the tests pinning the old contract
(`tests/github.test.ts:70,175,245,272,279,286,293,300,309,316` — including :272,
whose `toEqual({ degraded: false, retriedWithNewSha: false })` must drop the
removed field) to the new one: no re-resolve-and-retry; single POST attempt on the stale path. Update the doc
comments at `src/github.ts:26,124,126` (remove re-resolve language, state skip).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/github.test.ts tests/main.test.ts`
Expected: FAIL (old retry behavior / missing StaleHeadError).

- [ ] **Step 3: Implement the stale-skip in `src/github.ts` + `src/main.ts`**

In `postReview`: on `STALE_SHA` match, keep the `pulls.get` live-sha lookup
(unchanged error mapping), then `throw new StaleHeadError(commitId, head)`
instead of retrying. In `publishReview`: catch `StaleHeadError`, emit the exact
skip note via `note()`, set `out.staleSkipped = true` (new optional field on the
outcome) and `out.exitCode = 0`, return without posting. In `runFlowA` and
`runFlowB`: guard the `exitFor` overwrite with `if (!out.staleSkipped)`.

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
- Consumes: `parseSarif(text)` (exists; contract unchanged — its tests pin `toEqual([...])`).
- Produces: unchanged `fromStdout(tool, label, r, timeoutMs?)` signature; implementation
  `JSON.parse`s the stdout a second time in a `try/catch` (never touching `parseSarif`)
  and walks `runs[].invocations[]`: `executionSuccessful === false` or any
  error-level `toolExecutionNotifications` entry appends the exact message
  `` `${label} reported an unsuccessful run` `` as `warning("scanner-failed", ...)`.
  Exit-code fallback when SARIF carries no invocation info at all, keyed by an
  internal per-scanner findings-code table on the `label` (`semgrep: [1]`,
  `osv-scanner: [1]` matched by label prefix since osv labels carry the lockfile in
  parentheses, `trivy: []` — `tool` is `"docker"` for both trivy and osv, so the
  table must key on `label`, not `tool`): code in the table stays quiet, any other
  nonzero (or null/abnormal) appends the warning; code 0 stays quiet. Explicit
  invocation success wins over a contradictory exit code. When SARIF parses,
  `parseSarif`'s findings are always kept — the warning is appended, never substituted.

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
  // fromStdout("semgrep", "semgrep", code 1, ...) with one result → findings only, no warning.
});
it("trivy exit-1 with parseable SARIF warns (trivy findings exit is 0)", () => {
  // fromStdout("docker", "trivy", code 1, valid SARIF with one result, no invocations)
  // → findings plus the warning (proves the table keys on label, not tool).
});
it("fatal exit without invocation info still warns", () => {
  // code 2, valid SARIF with results but NO invocations key → findings plus the warning.
});
```

Check the `Exec` type fields (`missing`, `timedOut`, `code`, `stdout`) in `src/scanners.ts` and construct fakes accordingly.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/scanners.test.ts`
Expected: FAIL (no warning appended).

- [ ] **Step 3: Implement invocation-health check in `fromStdout`**

After successful `parseSarif`, re-parse the stdout JSON in a `try/catch` (never alter
`parseSarif` itself) and walk `runs[].invocations[]` per Interfaces, including the
exit-code rule for SARIF without invocation info. Apply the
same check to the file-report SARIF path (line ~380) if it parses the same
`runs` shape; otherwise note in the report why it is out of scope (that path parses
a report file, not a process result, so exit codes do not apply there — invocation
health still does if the shape matches).

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
- Produces: `ensureLinkedRepo` writes `<cloneDir>/.lupa-clone.json` (`{repo, branch, sha}`) inside the clone dir after a successful fresh clone (post-size-walk), so a wipe removes it with the dir; on an existing dir it validates before returning — `.git` present, marker parses with matching `repo`, `git config --get remote.origin.url` equals `https://github.com/${alias}.git`, `git rev-parse --abbrev-ref HEAD` equals marker branch, size walk within `maxBytes` (skipped when `maxBytes` is undefined). Any mismatch or git error → wipe (marker included) and run the full fresh-clone path. Success returns `{ dir: string; sha: string }` (sha now required; update fake results in `tests/linked-repos.test.ts` and `tests/main.test.ts` that construct `{ dir }` literals). `main.ts` `ensureLinked` closure logs the exact string `` `agent linked repo ${alias} at ${sha}` `` whenever `sha` is present.

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
it("logs the linked repo SHA on reuse", ...);
```

Determinism mechanism (no network): the fixture sets `RUNNER_TEMP` to a scratch
dir, pre-creates `<scratch>/lupa-linked/someone__else` as a real local git repo
(`git init -b main`, `git remote add origin https://github.com/someone/else.git`, one commit
with `git -c user.email=t@t -c user.name=t commit`, marker `.lupa-clone.json` with
matching repo/branch `someone/else`/`main`), then drives `run()` — validation passes on local git ops
only, no clone is attempted, and the log contains
"agent linked repo someone/else at <sha>". Requires a git binary (already required
by the existing clone-failure test).

Check how `core.info` is asserted in existing agent tests before writing the log test.

Existing `toEqual({ dir })` expectations at `tests/linked-repos.test.ts:76,113,176`
become `{ dir, sha }`; the "already-cloned dir is returned without running git"
test at `:102-113` is REPLACED by the non-git-dir re-clone test above (an empty dir
is exactly the force-reclone case now).

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
