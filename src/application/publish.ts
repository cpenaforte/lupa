import * as core from "@actions/core";
import { appendFileSync, statSync } from "node:fs";
import type { RunEnv, Deps, Outcome } from "./contracts.js";
import type { Finding } from "../domain/finding.js";
import type { AnalysisAssessment } from "../domain/assessment.js";
import { finalizeAssessment } from "../analysis/coverage.js";
import { readAssessment, writeAssessment } from "../artifacts/review-store.js";
import { renderAssessment } from "../review/render.js";
import type { FileDiff } from "../domain/diff.js";
import type { InlineComment, ReviewPayload } from "../domain/review.js";
import type { DedupVerdicts } from "../llm/types.js";
import { parseHunks } from "../diff/patch.js";
import { ReadonlyTokenError, StaleHeadError, type ReviewThread } from "../github.js";
import { buildBody, buildFallbackReport, formatBody, mapToComments, redactFindings } from "../review/render.js";
import { evaluateRawGate, eventFor, projectRenderMarks, reopenedKey } from "../review/policy.js";
import { groupFindings } from "../review/grouping.js";
import { memberRuleMarker, THREAD_BODY_BYTES } from "../review/thread-identity.js";
import { capBody, omissionMarkerFor, prioritizeFindings } from "../review/limits.js";
import { escapeProse } from "../domain/text.js";

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
  assessment: AnalysisAssessment;
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
    const head = `- ${escapeProse(`${c.path}:${c.line}`)}${suffix}`;
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
 * (getActor + listReviewThreads) is short-circuited when every raw finding
 * is already introduced — reopen can add nothing — or when no token is
 * configured (empty token: no call, no warn), and any thread/infra
 * failure falls back to diff-only gating without throwing.
 */
export async function publishReview(a: PublishArgs): Promise<{ blocking: Finding[]; assessment: AnalysisAssessment }> {
  let assessment = a.assessment;
  const persist = () => {
    assessment = writeAssessment(a.env.artifactDir, finalizeAssessment(assessment), a.env.inputs.maxArtifactBytes, runtimeSecrets(a.env));
    // A failed SHA-bound readback must retain sanitized accounting and disclose the loss.
    if (readAssessment(a.env.artifactDir, a.env.inputs.maxArtifactBytes) === undefined) {
      assessment.coverage.issues.push({ code: "assessment-unavailable", message: "Persisted assessment could not be validated against PR metadata." });
      assessment = writeAssessment(a.env.artifactDir, assessment, a.env.inputs.maxArtifactBytes, runtimeSecrets(a.env));
    }
    a.out.analysis = assessment;
  };
  const stale = () => {
    assessment.coverage.issues.push({ code: "stale-head", message: "The PR head changed; analysis applies only to the recorded head." });
    a.out.staleSkipped = true;
    persist();
    note(a.env, a.out, renderAssessment(assessment));
  };
  const fullSet = redactFindings(a.findings, runtimeSecrets(a.env));
  const inputs = a.env.inputs;
  const parsed = parseHunks(a.hunks);
  const { blocking: introduced } = evaluateRawGate(fullSet, parsed, a.hunks, [], undefined, { analysisPolicy: inputs.analysisPolicy });
  let actor: string | undefined;
  let threads: ReviewThread[] = [];
  if (introduced.length < fullSet.length && a.env.inputs.githubToken !== "") {
    try {
      actor = await a.deps.gh.getActor(a.pr);
      if (actor === undefined) {
        assessment.coverage.issues.push({ code: "actor-context", message: "Needed review actor recheck is unavailable." });
        core.warning("lupa: review actor unknown; skipping the wrongly-resolved re-check");
      } else {
        threads = await a.deps.gh.listReviewThreads(a.pr);
      }
    } catch {
      assessment.coverage.issues.push({ code: "actor-context", message: "Needed review-thread context is unavailable." });
      core.warning("lupa: review-thread re-read failed; gating on diff membership only");
      threads = [];
    }
  }
  if (introduced.length < fullSet.length && a.env.inputs.githubToken === "") {
    assessment.coverage.issues.push({ code: "actor-context", message: "Needed review actor recheck has no token." });
  }
  const decision = evaluateRawGate(fullSet, parsed, a.hunks, threads, actor, { analysisPolicy: inputs.analysisPolicy });
  assessment.coverage.issues.push(...decision.attributionIssues);
  persist();
  const blocking = decision.blocking;
  const { groups: proposedGroups, dropped } = groupFindings(fullSet, a.verdicts ?? { pairs: [], links: [], malformed: 0 });
  if (dropped > 0) core.warning(`lupa: ignored ${dropped} unmergeable dedup verdict(s)`);
  const identityMarkers = new Map<Finding, string>();
  // If the complete inline body cannot carry every member identity within
  // the byte bound, retain separate findings with their individual markers.
  // Singletons also need renderer-owned identity: finding prose may resemble
  // a terminal protocol marker and must never become authoritative metadata.
  const groups = proposedGroups.flatMap((group) => {
    const marker = memberRuleMarker([...new Set(group.members.map((i) => fullSet[i]!.rule))]);
    const largestBody = Math.max(...(["LEFT", "RIGHT"] as const).map((side) => Buffer.byteLength(formatBody(group.finding, side, true), "utf8")));
    if (largestBody + Buffer.byteLength(marker, "utf8") + 2 > THREAD_BODY_BYTES) {
      return group.members.map((i) => {
        const finding = fullSet[i]!;
        identityMarkers.set(finding, memberRuleMarker([finding.rule]));
        return { finding, members: [i] };
      });
    }
    identityMarkers.set(group.finding, marker);
    return [group];
  });
  const merged = groups.map((g) => g.finding);
  const { blocking: blockingKeys, reopened } = projectRenderMarks(groups, fullSet, decision);
  // Publication funnel: top-N by severity, then the inline cap (excess folds
  // to the body), then the body char cap. Gates keep the blocking set.
  const ordered = prioritizeFindings(merged);
  const retained = ordered.slice(0, inputs.maxFindings);
  const omitted = merged.length - retained.length;
  const omissionMarker = omitted > 0 ? omissionMarkerFor(omitted, inputs.maxFindings) : undefined;
  const { inline, general } = mapToComments(retained, parsed, reopened, identityMarkers);
  const postedInline = inline.slice(0, inputs.maxInlineComments);
  const excessInline = inline.slice(inputs.maxInlineComments);
  const coverageReport = capBody(renderAssessment(assessment), Math.min(16384, Math.floor(inputs.maxReviewBodyChars / 2)), []);
  let body = buildBody(general, `${summaryFor(fullSet)}\n\n${coverageReport}`, { reopened, blocking: blockingKeys });
  if (excessInline.length > 0) body += foldExcessInline(general.length === 0, excessInline, blockingKeys);
  const coverageMarker = `Analysis: ${assessment.status}; scope: ${assessment.scope}; ${assessment.coverage.hunksTotal - assessment.coverage.hunksReviewed} unreviewed hunks.`;
  const capped = capBody(body, inputs.maxReviewBodyChars, [...(Array.from(body).length > inputs.maxReviewBodyChars ? [coverageMarker] : []), ...(omissionMarker === undefined ? [] : [omissionMarker])]);
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
      const report = coverageReport + "\n\n" + buildFallbackReport(fullSet, { maxBytes: 1048576 - existing - Buffer.byteLength(coverageReport) - 3 });
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
        `inline=${postedInline.length}, general=${general.length + excessInline.length}, high=${high}, blocking=${merged.filter((f) => blockingKeys.has(reopenedKey(f))).length}, omitted=${omitted})`,
    );
    return { blocking, assessment };
  }
  const canWrite = !a.isFork || a.env.tokenType === "app" || a.env.tokenType === "workflow-run";
  if (!canWrite) {
    core.warning("fork PR with a read-only token: review not posted; summary and artifact only");
    return { blocking, assessment };
  }
  const live = await a.deps.gh.getPr(a.pr);
  if (live.headSha !== a.headSha) {
    stale();
    core.warning(`PR head moved from ${a.headSha} to ${live.headSha}: skipping review for the stale head`);
    return { blocking, assessment };
  }
  try {
    await a.deps.gh.createReview(a.pr, payload, { canWrite: true, maxBodyChars: inputs.maxReviewBodyChars, blocking: blockingKeys, commentKeys });
    a.out.posted = true;
  } catch (e) {
    if (e instanceof StaleHeadError) {
      stale();
      note(
        a.env,
        a.out,
        `lupa: PR head moved during posting; analyzed ${e.analyzedSha}, live ${e.liveSha}; skipping review for the stale head — a fresh run will cover the new head.`,
      );
      a.out.staleSkipped = true;
      a.out.exitCode = 0;
      return { blocking, assessment };
    }
    if (!(e instanceof ReadonlyTokenError)) throw e;
    core.error(`review post refused by GitHub: ${e.detail !== "" ? e.detail : e.message}`);
    // issuesWrite is derived from the environment: the template grants issues: write explicitly.
    // A live token-scope check is out of scope; an API refusal still degrades to a warning below.
    const issuesWrite = a.env.issueFallback && canWrite;
    if (!issuesWrite) {
      core.warning("issue fallback unavailable (not enabled, or token lacks issues: write); nothing posted");
      return { blocking, assessment };
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
      const fallbackBody = capBody(`${coverageReport}\n\n${fallbackReport}`, inputs.maxReviewBodyChars,
        [...(Array.from(coverageReport + fallbackReport).length + 2 > inputs.maxReviewBodyChars ? [coverageMarker] : []), ...(omissionMarker === undefined ? [] : [omissionMarker])]);
      await a.deps.gh.createIssueComment(a.pr, fallbackBody, { enabled: a.env.issueFallback, issuesWrite });
      a.out.posted = true;
    } catch (fallbackErr) {
      core.warning(`issue fallback failed: ${(fallbackErr as Error).message}`);
    }
  }
  return { blocking, assessment };
}
