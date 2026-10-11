# F07 — Complete fallback reporting

**Status:** Draft for review
**Date:** 2026-10-11

## Mission and context

Lupa provides reliable, actionable pull-request reviews, including routine review of AI-generated changes. It remains self-hosted in GitHub Actions, usable without an LLM key, and free of maintainer-paid inference, hosted services, and databases. F07 addresses a reporting failure that makes those reviews less useful: when findings are posted inline, the Step Summary and issue-comment fallback can show only a count, leaving no actionable defect details when the inline review is unavailable or a dry run is requested.

The current `publishReview` path maps findings to inline comments and general findings, builds one compact review body from only the general findings, then reuses that body for `GITHUB_STEP_SUMMARY` and the issue-comment fallback. An inline-only result therefore produces a count without its messages in those fallback destinations. `redactFindings` already runs before publication and must remain the boundary for every rendered finding.

## Desired outcome

Every existing fallback report is independently useful. The GitHub Step Summary contains a standalone report of every finding, including findings that also appear inline. The issue-comment fallback uses the same complete report when review creation is refused and fallback is enabled. A dry run still writes the complete report to the Step Summary when that path is available.

The pull-request review body remains compact and independent. It continues to contain the summary and findings that could not be placed inline. This change does not alter review event selection, exit codes, finding discovery, inline placement, or suggestion application policy.

## Design

Add a dedicated findings-report renderer, conceptually `buildFallbackReport(findings, options)`, alongside the existing review formatting in `src/review.ts`. Its input is the already-redacted `Finding[]`; it renders the original list in order, once per finding, without using the inline/general partition to decide which findings to show. It does not mutate findings or construct new evidence.

Each report starts with a finding-count heading, or `lupa: no findings.` for an empty list. Each finding includes:

- severity;
- location using the existing location convention (`file:line`, `file`, or `(repository)`);
- rule;
- the existing `message` as message/evidence, without paraphrasing or dropping it;
- the existing `suggestion` as suggested remediation when present, otherwise an explicit `No remediation supplied` value.

Finding-provided strings are untrusted Markdown content. Render them as plain text in Markdown code blocks, using a backtick fence longer than the longest backtick run in that field (minimum three backticks). This keeps multiline text, Markdown delimiters, and embedded backticks visible without allowing them to create headings, links, or new report sections. Label remediation as advice and use a normal `text` code fence, never GitHub's `suggestion` fence; this report must not turn prose into an applicable patch.

The same GitHub-Flavored Markdown report format serves the Step Summary and issue comment. The Step Summary receives it on every publication path, including `post_comment: false` dry runs. The compact `ReviewPayload.body` continues to come from `buildBody(general, summary)` and is not expanded with inline findings. The issue fallback receives the full report, not the compact review body. Existing permissions, stale-head checks, redaction, fallback enablement, and error/exit behavior remain unchanged. If no Step Summary path is available, do not add a new publication surface or emit the full report through logs as a substitute.

The renderer supports an optional caller-supplied UTF-8 byte limit so future publication limits can preserve whole finding records and report omissions accurately. With no limit, it renders the complete list. With a limit, it keeps the longest input-order prefix of complete records that fits while reserving room for a final marker stating the exact number of omitted findings. The limit covers the heading, records, and marker. Callers must provide enough budget for the heading and marker. F07 introduces no configured production aggregate limit; F15 will choose and propagate shared publication limits.

## Alternatives considered

- Expanding the PR review body to include inline findings would make ordinary reviews repetitive and couple fallback completeness to the inline comment API. Keep that body compact and provide a separate renderer.
- Adding a new artifact, comment, or publication destination would widen the trust and publication surface without fixing the existing destinations. Reuse only the Step Summary and the existing issue-comment fallback.
- Repeating only the finding count is the current defect. The report must render the details already available in each `Finding`.

## Scope boundaries

In scope: independent report formatting; complete visibility of inline and general findings in existing fallback/report destinations; safe formatting of multiline and Markdown-like values; exact omission reporting when a caller applies a renderer limit; tests for dry-run and issue fallback behavior.

Out of scope: new `Finding` fields or evidence provenance; changed scanner/LLM behavior; changes to review/blocking/exit policy; new publication surfaces; aggregate limit values or prioritization policy owned by F15; changes to Q01 suggestion-patch validation; new secrets or integrations.

## Acceptance criteria

1. A renderer test supplies inline-eligible and general findings and verifies that both appear once, in input order, with severity, location, rule, message/evidence, and remediation preserved.
2. Multiline messages and remediation containing Markdown syntax and backtick runs remain intact and cannot break the report's Markdown structure. Remediation remains ordinary advice, not a GitHub suggestion patch.
3. A renderer test supplies an output limit that omits findings and verifies the explicit omitted-finding count or marker; no shared production limit value is selected in F07.
4. `publishReview` tests prove an inline-only finding appears in `GITHUB_STEP_SUMMARY`, including `post_comment: false`, and in the issue-comment fallback when review creation is refused and fallback is enabled.
5. The ordinary PR review payload remains compact: inline-only findings are not copied into `ReviewPayload.body`.
6. The full report is built from the redacted findings used for publication; existing redaction coverage continues to pass.
7. Existing review event, blocking, stale-head, and issue-fallback failure behavior remains unchanged.

## References

- `docs/superpowers/plans/2026-10-11-p2-roadmap.md`, Task 43 — approved sequence and task-level tests.
- `docs/superpowers/specs/2026-10-11-p2-roadmap-design.md`, section “P2.1 — F07: complete fallback reporting” — approved F07 direction.
- `src/review.ts`: `mapToComments`, `buildBody`, `locate`, and existing suggestion formatting.
- `src/main.ts`: `summaryFor` and `publishReview`.
- `tests/review.test.ts`: review body and finding-format coverage.
- `tests/main.test.ts`: issue fallback, summary writing, dry-run, and publication coverage.
