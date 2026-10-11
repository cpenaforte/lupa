# F07 — Complete Fallback Reporting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement each task. Each task must be assigned to a fresh `gpt-6-luna` implementer and reviewed by a fresh `gpt-6.1-sol` reviewer; fix and re-review until clean before starting the next task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each existing fallback report include every redacted finding with its evidence and remediation, while keeping the pull-request review body compact.

**Architecture:** Add a dedicated Markdown renderer in `src/review.ts` that accepts the original findings list, uses safe dynamic code fences for untrusted values, and can omit only whole records under an optional UTF-8 byte limit. Wire its output to the Step Summary and issue-comment fallback in `src/main.ts`; keep `ReviewPayload.body` on the existing `buildBody(general, summary)` path.

**Tech Stack:** TypeScript 5.9, Node.js 24+, Vitest, esbuild committed bundle, GitHub Actions Step Summary and issue-comment APIs.

**Spec:** `docs/superpowers/specs/2026-10-11-f07-fallback-reporting-design.md`

## Global Constraints

- Lupa provides reliable, actionable pull-request reviews, including routine review of AI-generated changes. It remains self-hosted in GitHub Actions, usable without an LLM key, and free of maintainer-paid inference, hosted services, and databases.
- The pull-request review body remains compact and independent.
- This change does not alter review event selection, exit codes, finding discovery, inline placement, or suggestion application policy.
- Existing permissions, stale-head checks, redaction, fallback enablement, and error/exit behavior remain unchanged.
- If no Step Summary path is available, do not add a new publication surface or emit the full report through logs as a substitute.
- F07 introduces no configured production aggregate limit; F15 will choose and propagate shared publication limits.
- Do not change finding/blocking/suggestion-patch policy, add finding fields or publication surfaces, or select F15's shared aggregate limit values.
- Run full Vitest, `npx tsc --noEmit`, `npm run build`, and `node --check dist/index.js` for the completed source change; commit the generated `dist/index.js` bundle.

## Review Focus

- Finding-controlled Markdown/backticks in `file`, `rule`, `message`, and `suggestion` must stay inside their own text blocks; Task 1 pins dynamic fences, multiline content, and absence of a GitHub `suggestion` fence.
- A supplied UTF-8 byte budget must never split a finding or exceed the limit; Task 1 pins exact fit, one-byte-short, multibyte text, zero retained records, and an undersized minimum budget.
- Findings without a line and repository-level findings must keep their established locations; Task 1 pins `file` and `(repository)` locators.
- Inline-only findings must appear in both fallback destinations, including dry-run summaries, while remaining absent from the compact review body; Task 2 pins each channel and the payload boundary.
- Redaction must precede rendering in every fallback destination; Task 2 pins GitHub and LLM secrets in normal and dry-run summaries and in both issue-fallback outputs.

---

### Task 1: Render complete, bounded fallback reports

**Files:**
- Modify: `src/review.ts` (`locate`, existing `fenceFor`, and new report renderer)
- Test: `tests/review.test.ts`
- Generate: `dist/index.js`

**Interfaces:**
- Consumes: `Finding` from `src/fastpath.ts`; existing `locate(f)` and `fenceFor(value)` helpers in `src/review.ts`.
- Produces: `export function buildFallbackReport(findings: readonly Finding[], options: { maxBytes?: number } = {}): string`.

The renderer's exact format is:

```text
lupa: N finding(s).

### Finding 1

- Severity: warning
- Location:
${field(locate(f))}
- Rule:
${field(f.rule)}
- Message/evidence:
${field(f.message)}
- Suggested remediation (advice only):
${field(nonEmptySuggestionOrNoRemediation)}

> Omitted: N finding(s) omitted because the report output limit was reached.
```

The heading uses `lupa: no findings.` for an empty list. Each input finding appears once, in input order, as a record numbered from 1. `field(value)` is exactly `${fence}text\n${value}\n${fence}`, where `fence` is a backtick fence one longer than the longest run in that value, with a minimum of three. Render each finding-controlled value (`locate(f)`, `rule`, `message`, and non-empty `suggestion`) with that helper. Empty/missing suggestion becomes `No remediation supplied` in the same text block. Never use the `suggestion` info string. Separate heading, records, and optional omission marker with one blank line; return no trailing newline. The marker is exactly `> Omitted: N finding(s) omitted because the report output limit was reached.`

If `maxBytes` is absent, return the full report. If present, it must be a non-negative safe integer and the complete UTF-8 output, including heading and marker, must not exceed it. Return the full report when it fits; otherwise retain the longest input-order prefix of complete records that fits with the exact omitted-count marker. If even the heading plus marker cannot fit (or the empty-list heading cannot fit), throw `RangeError`. Never truncate a record or a field.

- [ ] **Step 1: Add failing renderer tests in `tests/review.test.ts`.** Import `buildFallbackReport` and add tests under `describe("buildFallbackReport", ...)`:
  - `renders every finding once in input order with all report fields`: pass one inline-eligible finding and one general finding; assert the exact header, severity, `src/a.ts:2` location, rule, full message, suggestion, and ordering; assert each message appears once.
  - `renders the no-findings heading`: assert an empty list returns exactly `lupa: no findings.`.
  - `renders file-only and repository locations and explicit missing remediation`: pass one file finding without a line and one `file: ""` finding with no suggestion; assert `b.ts`, `(repository)`, and `No remediation supplied`.
  - `contains hostile Markdown and multiline values in dynamic text fences`: include backtick runs and Markdown-looking multiline text independently in file, rule, message, and suggestion; assert each field is intact inside a fence longer than its longest run, all fences use `text`, and the output contains no `suggestion` info fence.
  - `fits the exact UTF-8 limit and reports omissions one byte below it`: use two findings with multibyte content and make the second record much larger than the omission marker; render once without a limit, then assert `maxBytes: Buffer.byteLength(full, "utf8")` returns `full`; at one byte less assert the result equals the full-report prefix ending after Finding 1's closing fence plus the exact `> Omitted: 1 finding(s) omitted because the report output limit was reached.` marker, and its UTF-8 byte length fits the budget.
  - `permits zero retained records when the heading and marker fit`: use a budget equal to the zero-record report with marker; assert no finding record appears and the exact number omitted is reported.
  - `rejects invalid and undersized byte limits`: table-test negative, fractional, `NaN`, infinite, and unsafe-integer limits; assert each and a below-minimum budget throw `RangeError` for non-empty findings, and a below-heading budget throws for an empty list.

  Pin the input-order, count-heading, all-field, and missing-remediation cases with concrete findings and assertions:

  ~~~ts
  const inline: Finding = { severity: "warning", file: "src/a.ts", line: 2, rule: "logic", message: "first evidence", suggestion: "apply first fix" };
  const general: Finding = { severity: "high", file: "", rule: "repository-rule", message: "second evidence" };
  const report = buildFallbackReport([inline, general]);
  expect(report).toContain("lupa: 2 finding(s).");
  expect(report).toContain("### Finding 1");
  expect(report).toContain("### Finding 2");
  for (const value of ["warning", "src/a.ts:2", "logic", "first evidence", "apply first fix", "high", "(repository)", "repository-rule", "second evidence", "No remediation supplied"]) {
    expect(report).toContain(value);
  }
  expect(report.indexOf("first evidence")).toBeLessThan(report.indexOf("second evidence"));
  expect(report.match(/first evidence/g)).toHaveLength(1);
  expect(report.match(/second evidence/g)).toHaveLength(1);

  const fileOnly = buildFallbackReport([{ severity: "info", file: "b.ts", rule: "line-less", message: "file evidence" }]);
  expect(fileOnly).toContain("b.ts");
  expect(fileOnly).toContain("No remediation supplied");
  ~~~

  Pin the hostile values and exact fence expectations in the test rather than deriving the expected fence with a copy of the renderer logic:

  ~~~ts
  const finding: Finding = {
    severity: "warning",
    file: "src/a.ts```\nmalicious",
    line: 2,
    rule: "rule````",
    message: "first line\n**bold** ```\n## fake heading",
    suggestion: "change ```\n- fake item",
  };
  const report = buildFallbackReport([finding]);
  expect(report).toContain("lupa: 1 finding(s).");
  expect(report).toContain("- Location:\n````text\nsrc/a.ts```\nmalicious:2\n````");
  expect(report).toContain("- Rule:\n`````text\nrule````\n`````");
  expect(report).toContain("- Message/evidence:\n````text\nfirst line\n**bold** ```\n## fake heading\n````");
  expect(report).toContain("- Suggested remediation (advice only):\n````text\nchange ```\n- fake item\n````");
  expect(report).not.toContain("suggestion\n");
  ~~~

  Pin UTF-8 accounting, exact omission count, complete retained fences, zero-retained behavior, and the minimum-budget boundary with literal expected output:

  ~~~ts
  const first: Finding = { severity: "info", file: "α.ts", line: 2, rule: "first", message: "evidence é" };
  const second: Finding = { severity: "warning", file: "b.ts", rule: "second", message: "é".repeat(256) };
  const findings = [first, second];
  const full = buildFallbackReport(findings);
  const fullBytes = Buffer.byteLength(full, "utf8");
  expect(buildFallbackReport(findings, { maxBytes: fullBytes })).toBe(full);

  const markerOne = "> Omitted: 1 finding(s) omitted because the report output limit was reached.";
  const firstRecordAndMarker = [
    "lupa: 2 finding(s).", "", "### Finding 1", "", "- Severity: info", "- Location:",
    "```text", "α.ts:2", "```", "- Rule:", "```text", "first", "```",
    "- Message/evidence:", "```text", "evidence é", "```", "- Suggested remediation (advice only):",
    "```text", "No remediation supplied", "```", "", markerOne,
  ].join("\n");
  const oneByteShort = buildFallbackReport(findings, { maxBytes: fullBytes - 1 });
  expect(oneByteShort).toBe(firstRecordAndMarker);
  expect(Buffer.byteLength(oneByteShort, "utf8")).toBeLessThanOrEqual(fullBytes - 1);

  const zeroRecords = "lupa: 2 finding(s).\n\n> Omitted: 2 finding(s) omitted because the report output limit was reached.";
  const minimumBytes = Buffer.byteLength(zeroRecords, "utf8");
  expect(buildFallbackReport(findings, { maxBytes: minimumBytes })).toBe(zeroRecords);
  expect(() => buildFallbackReport(findings, { maxBytes: minimumBytes - 1 })).toThrow(RangeError);
  expect(buildFallbackReport([], { maxBytes: Buffer.byteLength("lupa: no findings.", "utf8") })).toBe("lupa: no findings.");
  expect(() => buildFallbackReport([], { maxBytes: Buffer.byteLength("lupa: no findings.", "utf8") - 1 })).toThrow(RangeError);
  for (const maxBytes of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => buildFallbackReport([first], { maxBytes })).toThrow(RangeError);
  }
  ~~~
- [ ] **Step 2: Run the named tests and confirm they fail for the missing renderer or unmet assertions.**

  Run: `npx vitest run tests/review.test.ts -t "buildFallbackReport"`

  Expected: FAIL because the renderer is not implemented; do not proceed until this is a test failure rather than a setup error.
- [ ] **Step 3: Implement `buildFallbackReport(findings, options)` in `src/review.ts`.** Reuse `locate` and `fenceFor`; keep input findings immutable. Use `Buffer.byteLength(text, "utf8")` for the cap. Precompute rendered records and their UTF-8 byte lengths, then select the largest fitting prefix while reserving space for the marker with the correct omitted count. Throw `RangeError` for invalid limits or a budget below the required minimum.
- [ ] **Step 4: Run the renderer tests and the owning test file.**

  Run: `npx vitest run tests/review.test.ts -t "buildFallbackReport"`

  Expected: PASS for every named renderer case.

  Run: `npx vitest run tests/review.test.ts`

  Expected: PASS for the entire review test file, including existing `buildBody` behavior.
- [ ] **Step 5: Build and syntax-check the generated bundle.**

  Run: `npm run build`

  Expected: TypeScript and esbuild complete successfully and update `dist/index.js`.

  Run: `node --check dist/index.js`

  Expected: exit 0 with no syntax diagnostics.
- [ ] **Step 6: Commit the renderer task.**

  ```bash
  git add src/review.ts tests/review.test.ts dist/index.js
  git commit -m "feat: render complete fallback reports"
  ```

**Task gate:** Send this task's commit for a fresh `gpt-6.1-sol` review. If it reports findings, assign the fixes to the implementer and repeat the review until clean. Do not start Task 2 before the task gate is clean.

### Task 2: Publish the complete report on existing fallback channels

**Files:**
- Modify: `src/main.ts` (`publishReview`)
- Test: `tests/main.test.ts`
- Generate: `dist/index.js`

**Interfaces:**
- Consumes: Task 1's `buildFallbackReport(findings: readonly Finding[], options?: { maxBytes?: number }): string`.
- Produces: `ReviewPayload.body` continues to be constructed with `buildBody(general, summaryFor(findings))`; the complete report is written to `summaryPath` when present and passed to `createIssueComment` only on the existing enabled/refused-review fallback path.

- [ ] **Step 1: Add failing `publishReview` channel tests in `tests/main.test.ts`.** Use the existing `runWithMocks`, `LLM_FINDING`, and `DIFF` fixtures; `LLM_FINDING` at `src/a.ts:2` is inline-eligible.
  - `Step Summary includes an inline-only finding and its remediation`: use a non-empty suggestion; assert severity, location, rule, message, the `Suggested remediation (advice only)` label, and exact suggestion text.
  - `dry-run Step Summary includes an inline-only finding and its remediation`: use `postComment: false` with a distinct non-empty suggestion; assert no review was posted and the Step Summary contains all finding details and the suggestion.
  - `issue fallback publishes the complete report for an inline-only finding`: use `write403: true`, `issueFallback: true`, and a non-empty suggestion; assert severity, location, rule, message, and suggestion in the comment; after trimming the summary file's final newline, assert it equals the issue comment and `posted` is true.
  - `complete fallback report stays out of the compact review body`: with a non-empty suggestion, assert the inline comment contains the finding and suggestion, while `reviews[0].body` contains the count but not the inline-only message or suggestion.
  - `normal Step Summary redacts GitHub and LLM secrets` and `dry-run Step Summary redacts GitHub and LLM secrets`: put both secrets across file, rule, message, and suggestion; assert the summary contains `[REDACTED]` and neither original secret.
  - `issue fallback redacts both fallback report destinations`: trigger the refused-review fallback with those secrets; assert the Step Summary and issue comment each contain `[REDACTED]` and neither original secret.

  Pin channel routing, detailed fields, and the compact payload boundary with explicit test assertions:

  ~~~ts
  const finding = { ...LLM_FINDING, suggestion: "Use a bounded check." };
  const normal = await runWithMocks({ llm: [finding] });
  const summary = readFileSync(normal.summaryPath, "utf8");
  for (const text of ["warning", "src/a.ts:2", "logic", "llm message", "Use a bounded check."]) {
    expect(summary).toContain(text);
  }
  expect(normal.reviews[0]!.comments[0]!.body).toContain("Use a bounded check.");
  expect(normal.reviews[0]!.body).toContain("1 finding(s)");
  expect(normal.reviews[0]!.body).not.toContain(finding.message);
  expect(normal.reviews[0]!.body).not.toContain(finding.suggestion);

  const dry = await runWithMocks({ postComment: false, llm: [{ ...finding, suggestion: "Keep this advice." }] });
  expect(dry.posted).toBe(false);
  expect(readFileSync(dry.summaryPath, "utf8")).toContain("Keep this advice.");

  const refused = await runWithMocks({ write403: true, issueFallback: true, llm: [finding] });
  expect(refused.issueComments[0]).toContain("Use a bounded check.");
  expect(refused.issueComments[0]).toBe(readFileSync(refused.summaryPath, "utf8").trimEnd());
  ~~~

  Pin the secret fields and all rendered destinations with a concrete fixture:

  ~~~ts
  const githubToken = "gh-secret-token-123";
  const llmApiKey = "sk-secret-key-456";
  const leaked: Finding = {
    severity: "warning",
    file: `src/${githubToken}-${llmApiKey}.ts`,
    line: 2,
    rule: `${githubToken}-${llmApiKey}`,
    message: `${githubToken} ${llmApiKey}`,
    suggestion: `replace ${githubToken} ${llmApiKey}`,
  };
  const normalRedaction = await runWithMocks({ githubToken, llmApiKey, llm: [leaked] });
  const dryRedaction = await runWithMocks({ githubToken, llmApiKey, postComment: false, llm: [leaked] });
  for (const result of [normalRedaction, dryRedaction]) {
    const summary = readFileSync(result.summaryPath, "utf8");
    expect(summary).not.toContain(githubToken);
    expect(summary).not.toContain(llmApiKey);
    for (const redacted of ["src/[REDACTED]-[REDACTED].ts:2", "[REDACTED]-[REDACTED]", "[REDACTED] [REDACTED]", "replace [REDACTED] [REDACTED]"]) {
      expect(summary).toContain(redacted);
    }
  }
  const fallbackRedaction = await runWithMocks({ githubToken, llmApiKey, write403: true, issueFallback: true, llm: [leaked] });
  const summary = readFileSync(fallbackRedaction.summaryPath, "utf8");
  for (const output of [summary, fallbackRedaction.issueComments[0]!]) {
    expect(output).not.toContain(githubToken);
    expect(output).not.toContain(llmApiKey);
    expect(output).toContain("replace [REDACTED] [REDACTED]");
  }
  ~~~
- [ ] **Step 2: Run the new `publishReview` tests and confirm the missing behavior fails.**

  Run: `npx vitest run tests/main.test.ts -t "inline-only finding|compact review body|Step Summary redacts|issue fallback redacts"`

  Expected: FAIL because the Step Summary and fallback still use the compact body; do not proceed until this is a test failure rather than a setup error.
- [ ] **Step 3: Wire the renderer into `publishReview` in `src/main.ts`.** After `redactFindings` and `mapToComments`, build `const report = buildFallbackReport(findings)`. Keep `body = buildBody(general, summaryFor(findings))` for `ReviewPayload.body`; append `report + "\n"` to `summaryPath` when available; pass `report` to `createIssueComment`. Leave dry-run, permission, stale-head, redaction, fallback, error, and exit branches otherwise unchanged.
- [ ] **Step 4: Run the focused publication tests and the entire main test file.**

  Run: `npx vitest run tests/main.test.ts -t "inline-only finding|compact review body|Step Summary redacts|issue fallback redacts"`

  Expected: PASS for the new normal/dry-run Step Summary, issue-fallback, compact-body, and redaction assertions.

  Run: `npx vitest run tests/main.test.ts`

  Expected: PASS for all main-flow tests, including existing fallback, stale-head, and blocking behavior.
- [ ] **Step 5: Run the full F07 verification gates.**

  Run: `npx vitest run`

  Expected: all Vitest tests pass.

  Run: `npx tsc --noEmit`

  Expected: exit 0 with no type diagnostics.

  Run: `npm run build && node --check dist/index.js`

  Expected: the committed bundle builds and passes the syntax check.

  Run: `git diff --check`

  Expected: no whitespace errors.
- [ ] **Step 6: Commit the publication wiring.**

  ```bash
  git add src/main.ts tests/main.test.ts dist/index.js
  git commit -m "feat: publish complete fallback reports"
  ```

**Task gate:** Send this task's commit for a fresh `gpt-6.1-sol` review. If it reports findings, assign the fixes to the implementer and repeat the review until clean. After both task gates pass, run a fresh whole-branch `gpt-6.1-sol` review and resolve any findings before declaring F07 complete.

## References

- `docs/superpowers/specs/2026-10-11-f07-fallback-reporting-design.md` — approved behavior, boundaries, and acceptance criteria.
- `docs/superpowers/plans/2026-10-11-p2-roadmap.md`, Task 43 — sequencing and F07 verification requirements.
- `src/review.ts` and `tests/review.test.ts` — current finding-location, fence, and compact review-body conventions.
- `src/main.ts` and `tests/main.test.ts` — current redaction, Step Summary, dry-run, and issue-fallback seams.
