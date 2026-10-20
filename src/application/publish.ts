import * as core from "@actions/core";
import { appendFileSync, statSync } from "node:fs";
import type { RunEnv, Deps, Outcome } from "./contracts.js";
import type { Finding } from "../domain/finding.js";
import type { FileDiff } from "../domain/diff.js";
import type { InlineComment, ReviewPayload } from "../domain/review.js";
import type { DedupVerdicts } from "../llm/types.js";
import { parseHunks } from "../diff/patch.js";
import { ReadonlyTokenError, StaleHeadError } from "../github.js";
import { buildBody, buildFallbackReport, mapToComments, redactFindings } from "../review/render.js";
import { eventFor, partitionGate, reopenedKey, resolveReopened } from "../review/policy.js";
import { mergeDuplicates } from "../review/grouping.js";
import { capBody, omissionMarkerFor, prioritizeFindings } from "../review/limits.js";

/** Logs a line and, when a summary file exists, appends it there (skip paths must leave evidence).
 * The append is best-effort: an unwritable summary path warns but never throws, so a skip path
 * still exits 0. */
export function note(env: RunEnv, out: Outcome, text: string): void {
  core.info(text);
  if (env.summaryPath !== undefined) {
    try {
      appendFileSync(env.summaryPath, text + "\n", "utf8");
      out.summaryWritten = true;
    } catch (e) {
      core.warning(`could not write summary: ${(e as Error).message}`);
    }
  }
}

function summaryFor(findings: Finding[]): string {
  return findings.length === 0 ? "lupa: no findings." : `lupa: ${findings.length} finding(s).`;
}

// Artifact redaction is runtime-key masking only: the run's own github_token and
// llm_api_key values are masked from findings.json and sarif.json. Secrets
// committed in the diff are a separate scanner concern and are not covered.
export function runtimeSecrets(env: RunEnv): string[] {
  return [env.inputs.githubToken, env.inputs.llmApiKey].filter(s => s !== "");
}

interface PublishArgs {
  env: RunEnv;
  deps: Deps;
  out: Outcome;
  pr: number;
  isFork: boolean;
  findings: Finding[];
  hunks: FileDiff[];
  headSha: string;
  verdicts?: DedupVerdicts;
}

/**
 * Renders overflow inline comments into body text in the same item shape as
 * the off-diff fold in github.ts (`- path:line` plus two-space-indented
 * continuation lines). Items outside the blocking set carry a ` (non-blocking)`
 * suffix (rule absent means assume blocking: no marker). When the general
 * section is empty the block carries its heading; otherwise it continues the
 * existing list.
 */
function foldExcessInline(withHeading: boolean, excess: InlineComment[], blocking?: ReadonlySet<string>): string {
  const items = excess.map((c) => {
    const text = c.body.replace(/\r\n?/g, "\n").replace(/(\n[ \t]*)+$/, "");
    const key = c.rule === undefined ? null : `${c.rule}\0${c.path}\0${c.line}`;
    const suffix = key !== null && blocking !== undefined && !blocking.has(key) ? " (non-blocking)" : "";
    const head = `- ${c.path}:${c.line}${suffix}`;
    if (text.trim() === "") return head;
    return `${head}\n  ${text.replace(/\n/g, "\n  ")}`;
  });
  return withHeading ? `\n\n**Findings not placed inline:**\n${items.join("\n")}` : `\n${items.join("\n")}`;
}

/**
 * Posts one review for `headSha`, or dry-runs it. Writes the summary in every case. Posts only
 * when the token can write and the PR head still equals `headSha` (checked via the API).
 * A failed issue fallback is a warning; it never changes the exit code.
 *
 * The blocking set (PR-touched findings plus wrongly-resolved reopened ones) is
 * computed BEFORE all early returns (dry-run, fork-readonly, stale-head) and
 * returned for the flow exits, so every exit path gates on it. The reopen read
 * (getActor + listReviewThreads) is short-circuited when every merged finding
 * is already introduced — reopen can add nothing — or when no token is
 * configured (empty token: no call, no warn), and any thread/infra
 * failure falls back to diff-only gating without throwing.
 */
export async function publishReview(a: PublishArgs): Promise<{ blocking: Finding[] }> {
  const fullSet = redactFindings(a.findings, runtimeSecrets(a.env));
  const inputs = a.env.inputs;
  // Dedup merge before the funnel. Gate inputs keep the full pre-merge set (provably
  // identical outcomes); the funnel — top-N, inline, body — runs on the merged set, and
  // omission counts reflect the post-merge cut (merged-away findings are represented, never omitted).
  const { merged, dropped } =
    a.verdicts === undefined ? { merged: fullSet, dropped: 0 } : mergeDuplicates(fullSet, a.verdicts);
  if (dropped > 0) core.warning(`lupa: ignored ${dropped} unmergeable dedup verdict(s)`);
  const parsed = parseHunks(a.hunks);
  const { introduced } = partitionGate(merged, parsed, a.hunks);
  const introducedKeys = new Set(introduced.map(reopenedKey));
  let reopened = new Set<string>();
  if (introduced.length < merged.length && a.env.inputs.githubToken !== "") {
    try {
      const self = await a.deps.gh.getActor(a.pr);
      if (self === undefined) {
        core.warning("lupa: review actor unknown; skipping the wrongly-resolved re-check");
      } else {
        reopened = resolveReopened(merged, await a.deps.gh.listReviewThreads(a.pr), self);
      }
    } catch {
      core.warning("lupa: review-thread re-read failed; gating on diff membership only");
      reopened = new Set<string>();
    }
  }
  // Single filter over merged in merged order: introduced or reopened. A
  // finding that is both is counted once (never concatenated).
  const blocking = merged.filter((f) => introducedKeys.has(reopenedKey(f)) || reopened.has(reopenedKey(f)));
  const blockingKeys = new Set(blocking.map(reopenedKey));
  // Publication funnel: top-N by severity, then the inline cap (excess folds
  // to the body), then the body char cap. Gates keep the blocking set.
  const ordered = prioritizeFindings(merged);
  const retained = ordered.slice(0, inputs.maxFindings);
  const omitted = merged.length - retained.length;
  const omissionMarker = omitted > 0 ? omissionMarkerFor(omitted, inputs.maxFindings) : undefined;
  const { inline, general } = mapToComments(retained, parsed, reopened);
  const postedInline = inline.slice(0, inputs.maxInlineComments);
  const excessInline = inline.slice(inputs.maxInlineComments);
  let body = buildBody(general, summaryFor(fullSet), { reopened, blocking: blockingKeys });
  if (excessInline.length > 0) body += foldExcessInline(general.length === 0, excessInline, blockingKeys);
  const capped = capBody(body, inputs.maxReviewBodyChars, omissionMarker === undefined ? [] : [omissionMarker]);
  // commentKeys ride index-aligned with the posted comments for the 422 fold path;
  // rule is internal (fold keys only) and never ships in the payload.
  const commentKeys = postedInline.map((c) => (c.rule === undefined ? null : `${c.rule}\0${c.path}\0${c.line}`));
  const payload: ReviewPayload = {
    commit_id: a.headSha,
    body: capped,
    event: eventFor(inputs.failLevel, blocking),
    comments: postedInline.map(({ rule, ...c }) => c),
  };
  if (a.env.summaryPath !== undefined) {
    // The 1 MiB platform ceiling minus bytes already in the file minus the
    // trailing newline the append adds; a missing file counts as empty.
    let existing = 0;
    try {
      existing = statSync(a.env.summaryPath).size;
    } catch {
      existing = 0;
    }
    try {
      const report = buildFallbackReport(fullSet, { maxBytes: 1048576 - existing - 1 });
      appendFileSync(a.env.summaryPath, report + "\n", "utf8");
      a.out.summaryWritten = true;
    } catch (e) {
      core.warning(`summary report skipped: ${(e as Error).message}`);
    }
  }
  if (!a.env.inputs.postComment) {
    const high = fullSet.filter((f) => f.severity === "high").length;
    core.info(
      `post_comment is false: dry-run, nothing posted (would post event=${payload.event}, ` +
        `inline=${postedInline.length}, general=${general.length + excessInline.length}, high=${high}, blocking=${blocking.length}, omitted=${omitted})`,
    );
    return { blocking };
  }
  const canWrite = !a.isFork || a.env.tokenType === "app" || a.env.tokenType === "workflow-run";
  if (!canWrite) {
    core.warning("fork PR with a read-only token: review not posted; summary and artifact only");
    return { blocking };
  }
  const live = await a.deps.gh.getPr(a.pr);
  if (live.headSha !== a.headSha) {
    core.warning(`PR head moved from ${a.headSha} to ${live.headSha}: skipping review for the stale head`);
    return { blocking };
  }
  try {
    await a.deps.gh.createReview(a.pr, payload, { canWrite: true, maxBodyChars: inputs.maxReviewBodyChars, blocking: blockingKeys, commentKeys });
    a.out.posted = true;
  } catch (e) {
    if (e instanceof StaleHeadError) {
      note(
        a.env,
        a.out,
        `lupa: PR head moved during posting; analyzed ${e.analyzedSha}, live ${e.liveSha}; skipping review for the stale head — a fresh run will cover the new head.`,
      );
      a.out.staleSkipped = true;
      a.out.exitCode = 0;
      return { blocking };
    }
    if (!(e instanceof ReadonlyTokenError)) throw e;
    core.error(`review post refused by GitHub: ${e.detail !== "" ? e.detail : e.message}`);
    // issuesWrite is derived from the environment: the template grants issues: write explicitly.
    // A live token-scope check is out of scope; an API refusal still degrades to a warning below.
    const issuesWrite = a.env.issueFallback && canWrite;
    if (!issuesWrite) {
      core.warning("issue fallback unavailable (not enabled, or token lacks issues: write); nothing posted");
      return { blocking };
    }
    try {
      // The fallback publishes the retained (publication-capped) set with the
      // publication omission marker prepended; its native marker covers any
      // further byte overflow. The char-cap value doubles as a conservative
      // byte budget (stricter for multibyte text, never looser).
      const budget =
        omissionMarker === undefined
          ? inputs.maxReviewBodyChars
          : inputs.maxReviewBodyChars - Buffer.byteLength(omissionMarker, "utf8") - 2;
      const fallbackReport = buildFallbackReport(retained, { maxBytes: budget });
      const fallbackBody = omissionMarker === undefined ? fallbackReport : `${omissionMarker}\n\n${fallbackReport}`;
      await a.deps.gh.createIssueComment(a.pr, fallbackBody, { enabled: a.env.issueFallback, issuesWrite });
      a.out.posted = true;
    } catch (fallbackErr) {
      core.warning(`issue fallback failed: ${(fallbackErr as Error).message}`);
    }
  }
  return { blocking };
}
