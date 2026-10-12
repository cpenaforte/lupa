import * as core from "@actions/core";
import { context, getOctokit } from "@actions/github";
import { appendFileSync, copyFileSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  filterForPrompt,
  isLockfile,
  parseHunks,
  PER_FILE_CAP,
  readPrMeta,
  truncateDiff,
  writePrMeta,
  type FileDiff,
  type PrMeta,
} from "./diff.js";
import { capText, MSG_CAP, RULE_CAP, runL0, TRUNC_MARK, type Finding } from "./fastpath.js";
import { runL2 } from "./l2.js";
import { TOOL_DEFS, type ToolContext } from "./agent-tools.js";
import { AGENT_LIMITS, type Conversation } from "./agent-types.js";
import {
  getRepoSize as fetchRepoSize,
  postIssueFallback,
  postReview,
  ReadonlyTokenError,
  resolvePrNumber,
  shouldTrigger,
  StaleHeadError,
} from "./github.js";
import { getInputs, DEFAULT_MAX_ARTIFACT_BYTES, type ActionInputs } from "./inputs.js";
import { ensureLinkedRepo, parseLinkedRepos } from "./linked-repos.js";
import {
  callByStyle,
  callByStyleAgent as runStyleAgent,
  callWithProbe,
  callWithProbeAgent as runProbeAgent,
  ensureOllama,
  type DedupVerdicts,
  type LlmResult,
} from "./llm.js";
import { buildMessages, ISSUE_TRUNCATION_MARKER, linkedIssueNumber, neutralise } from "./prompt.js";
import { catalogProtocolFor, checkModelListed, resolveEndpoint, type CatalogProtocol, type ResolvedEndpoint } from "./providers.js";
import { buildBody, buildFallbackReport, capBody, eventFor, exitFor, mapToComments, mergeDuplicates, omissionMarkerFor, prioritizeFindings, redactFindings, type InlineComment, type ReviewPayload } from "./review.js";
import { runScanners, type ScannerResult } from "./scanners.js";
import { readCappedFileSync } from "./artifact-limits.js";

/** Everything the run needs from the environment. Built by readRunEnv() in production. */
export interface RunEnv {
  eventName: string;
  payload: Record<string, unknown>;
  inputs: ActionInputs;
  /** Checkout of the PR head (the template checks it out detached at HEAD_SHA). */
  workDir: string;
  /** Holds diff.patch (written by the template); receives pr-meta.json, findings.json, sarif, sbom. */
  artifactDir: string;
  baseSha: string;
  headSha: string;
  /** PR_REVIEWER_TOKEN_TYPE: "app" or "workflow-run" may write on a fork PR; "github-token" (and unset/unknown) never posts on a fork. */
  tokenType: "app" | "workflow-run" | "github-token";
  /** PR_REVIEWER_ISSUE_FALLBACK === "true". Only set when the template grants issues: write. */
  issueFallback: boolean;
  /** GITHUB_STEP_SUMMARY, when present. */
  summaryPath?: string;
}

export interface PrInfo {
  body: string;
  headSha: string;
  headRepo: string;
  headRef: string;
  isFork: boolean;
}

/** GitHub API boundary. Production wraps Octokit; tests inject fakes. */
export interface Gateway {
  getPr(pr: number): Promise<PrInfo>;
  /** Open PR numbers in the base repository whose head is `headRepo:headRef`. */
  findPrsByHead(headRepo: string, headRef: string): Promise<number[]>;
  getIssueBody(issue: number): Promise<string>;
  /** Repository size in KB, or undefined when unknown (any API error). */
  getRepoSize(owner: string, repo: string): Promise<number | undefined>;
  createReview(pr: number, payload: ReviewPayload, opts: { canWrite: boolean; maxBodyChars?: number }): Promise<void>;
  createIssueComment(pr: number, body: string, opts: { enabled: boolean; issuesWrite: boolean }): Promise<void>;
}

/** Scanner, linter and LLM boundary. The privileged flow never invokes these. */
export interface Analysis {
  runScanners(o: Parameters<typeof runScanners>[0]): Promise<ScannerResult>;
  runL2(dir: string, changedFiles?: Set<string>): Promise<Finding[]>;
  ensureOllama(baseUrl: string, model: string, o: { timeoutSeconds?: number; apiKey?: string }): Promise<void>;
  checkModelListed(baseUrl: string, model: string, apiKey: string, protocol: CatalogProtocol): Promise<{ status: "listed" | "absent" | "unknown"; detail?: string }>;
  /** Single call to the endpoint's already-resolved style (explicit style / llm_path override). */
  callByStyle(ep: ResolvedEndpoint, messages: { system: string; user: string }, o: Parameters<typeof callByStyle>[2]): Promise<LlmResult>;
  /** Error-driven style routing (spec §9.5); the real seam logs the winning style. */
  callWithProbe(
    provider: string,
    model: string,
    baseUrl: string,
    apiKey: string,
    messages: { system: string; user: string },
    o: Parameters<typeof callWithProbe>[5],
  ): Promise<LlmResult>;
  /** Agent-mode single call against the endpoint's already-resolved style. */
  callByStyleAgent(
    ep: ResolvedEndpoint,
    conv: Parameters<typeof runStyleAgent>[1],
    o: Parameters<typeof runStyleAgent>[2],
    toolCtx: ToolContext,
  ): Promise<LlmResult>;
  /** Agent-mode error-driven style routing; the real seam logs the winning style. */
  callWithProbeAgent(
    provider: string,
    model: string,
    baseUrl: string,
    apiKey: string,
    conv: Parameters<typeof runProbeAgent>[4],
    o: Parameters<typeof runProbeAgent>[5],
    toolCtx: ToolContext,
  ): Promise<LlmResult>;
}

export interface Deps {
  gh: Gateway;
  analysis: Analysis;
}

export interface Outcome {
  posted: boolean;
  summaryWritten: boolean;
  exitCode: number;
  findingsFrom: "llm" | "fastpath";
  slowPathSkipped: boolean;
  issueBodyFetched?: number;
  staleSkipped?: boolean;
}

interface EventFields {
  action?: string;
  comment?: { body?: string; author_association?: string };
  review?: { body?: string; author_association?: string };
  issue?: { number: number; pull_request?: unknown };
  pull_request?: { number: number };
  workflow_run?: {
    id?: number;
    head_sha?: string;
    head_branch?: string;
    head_repository?: { full_name?: string } | null;
  };
}

const SHA_RE = /^[0-9a-f]{40}$/;
const SEVERITIES: ReadonlySet<string> = new Set(["info", "warning", "high"]);
const SUGGESTION_CAP = 4000;
const FILE_CAP = 200;
/** Emitted in place of L2 execution on fork PRs with secrets in scope. */
const L2_SKIPPED: Finding = {
  severity: "info",
  file: "",
  rule: "l2-skipped",
  message:
    "L2 native toolchains were not executed: fork PR with secrets in scope. Semgrep, gitleaks and trivy still ran.",
};

/** Lockfile basename to the manifest that must change with it. Unmapped lockfiles are not flagged. */
const MANIFEST_FOR: Readonly<Record<string, string>> = {
  "package-lock.json": "package.json",
  "npm-shrinkwrap.json": "package.json",
  "pnpm-lock.yaml": "package.json",
  "yarn.lock": "package.json",
  "bun.lock": "package.json",
  "bun.lockb": "package.json",
  "Cargo.lock": "Cargo.toml",
  "go.sum": "go.mod",
  "Gemfile.lock": "Gemfile",
  "poetry.lock": "pyproject.toml",
  "uv.lock": "pyproject.toml",
  "Pipfile.lock": "Pipfile",
  "composer.lock": "composer.json",
  "pubspec.lock": "pubspec.yaml",
  "Podfile.lock": "Podfile",
  "flake.lock": "flake.nix",
};

// ---------------------------------------------------------------------------
// Exec environment scrubbing (R1). Scanners and linters run PR-controlled code
// (build scripts, configs), so they must not inherit secrets.
// ---------------------------------------------------------------------------

const EXEC_ALLOW: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "LC_ALL",
  "TZ",
  "TMPDIR",
  "GITHUB_WORKSPACE",
  "SYSTEMROOT",
  "PATHEXT",
  "DOCKER_HOST",
]);
const EXEC_ALLOW_PREFIX = ["RUNNER_"];
/** Deny wins over the allowlist. */
const EXEC_DENY = /TOKEN|KEY|SECRET|PASSWORD|AUTH|^GITHUB_TOKEN$|^ACTIONS_/i;

/** The environment handed to PR-controlled exec: allowlisted names only, never secret-shaped names. */
export function cleanEnvForExec(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || EXEC_DENY.test(k)) continue;
    if (EXEC_ALLOW.has(k) || EXEC_ALLOW_PREFIX.some((p) => k.startsWith(p))) out[k] = v;
  }
  return out;
}

/**
 * Runs `fn` with process.env replaced by the scrubbed exec env. Scanners and L2 spawn children
 * that inherit process.env at spawn time, so the swap reaches them without changing their modules.
 * Restored in `finally`. Calls are sequential in run(), so the window never overlaps another call.
 */
async function withScrubbedEnv<T>(fn: () => Promise<T>): Promise<T> {
  const saved: NodeJS.ProcessEnv = { ...process.env };
  const clean = cleanEnvForExec(saved);
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, clean);
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

// ---------------------------------------------------------------------------
// Diff and artifact helpers
// ---------------------------------------------------------------------------

function newOutcome(): Outcome {
  return { posted: false, summaryWritten: false, exitCode: 0, findingsFrom: "fastpath", slowPathSkipped: false };
}

function requireSha(name: string, value: string): void {
  if (!SHA_RE.test(value)) throw new Error(`lupa: ${name} must be a 40-character lowercase commit SHA`);
}

function readDiff(dir: string): string {
  const path = join(dir, "diff.patch");
  if (!existsSync(path)) throw new Error(`lupa: diff.patch not found in ${dir}`);
  return readFileSync(path, "utf8");
}

function sizeOf(workDir: string | undefined, file: string): number {
  if (workDir === undefined) return 0;
  try {
    return statSync(join(workDir, file)).size;
  } catch {
    return 0;
  }
}

/**
 * Decodes a git C-style quoted path (`"caf\303\251.txt"`). Unquoted input is returned as-is.
 * `core.quotePath=false` avoids most quoting; this covers residual quoted names defensively.
 */
export function unquoteGitPath(s: string): string {
  if (s.length < 2 || !s.startsWith('"') || !s.endsWith('"')) return s;
  const body = s.slice(1, -1);
  const simple: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '"': 34, "\\": 92 };
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== "\\") {
      bytes.push(...Buffer.from(c, "utf8"));
      continue;
    }
    const octal = body.slice(i + 1, i + 4);
    if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(parseInt(octal, 8));
      i += 3;
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) break;
    bytes.push(simple[next] ?? Buffer.from(next, "utf8")[0]);
    i += 1;
  }
  return Buffer.from(bytes).toString("utf8");
}

/** The b-side path of a `diff --git` header, or undefined when the header is not recognized. */
function headerFile(line: string): string | undefined {
  const quoted = /^diff --git ("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/.exec(line);
  if (quoted) {
    const b = unquoteGitPath(quoted[2]);
    return b.startsWith("b/") ? b.slice(2) : undefined;
  }
  const plain = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
  return plain ? plain[2] : undefined;
}

/**
 * Splits `git diff -U3` output into per-file sections. `hunks` starts at the first `@@`, so
 * file headers never reach the hunk parsers. Binary sections are flagged from git's own text.
 */
function parseDiffFiles(text: string, workDir?: string): FileDiff[] {
  type Section = { file: string; lines: string[]; binary: boolean };
  const sections: Section[] = [];
  let cur: Section | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const file = headerFile(line);
      cur = file === undefined ? undefined : { file, lines: [], binary: false };
      if (cur !== undefined) sections.push(cur);
      continue;
    }
    if (cur === undefined) continue;
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) cur.binary = true;
    cur.lines.push(line);
  }
  return sections.map((s) => {
    const at = s.lines.findIndex((l) => l.startsWith("@@"));
    const hunks = at === -1 ? "" : s.lines.slice(at).join("\n").replace(/\n+$/, "");
    // Real on-disk size, so the large-file rule fires for binaries over 500 KB. A hunk-less text entry
    // (mode-only change) reports 0: L0 would otherwise read it as a binary-note.
    const size = hunks === "" && !s.binary ? 0 : sizeOf(workDir, s.file);
    const f: FileDiff = { file: s.file, hunks, truncated: false, size };
    if (s.binary) f.binary = true;
    return f;
  });
}

function isFinding(v: unknown): v is Finding {
  if (typeof v !== "object" || v === null) return false;
  const f = v as Record<string, unknown>;
  return (
    typeof f.severity === "string" &&
    SEVERITIES.has(f.severity) &&
    typeof f.file === "string" &&
    typeof f.rule === "string" &&
    typeof f.message === "string" &&
    (f.line === undefined || (typeof f.line === "number" && Number.isInteger(f.line) && f.line >= 1)) &&
    (f.suggestion === undefined || typeof f.suggestion === "string")
  );
}

export function readFindings(dir: string, maxBytes: number = DEFAULT_MAX_ARTIFACT_BYTES): Finding[] {
  const path = join(dir, "findings.json");
  if (!existsSync(path)) throw new Error(`lupa: findings.json not found in ${dir}`);
  const capped = readCappedFileSync(path, maxBytes);
  if (!capped.ok) throw new Error(`lupa: findings.json exceeds the artifact read limit (${maxBytes} bytes)`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(capped.text);
  } catch {
    throw new Error("lupa: findings.json is malformed JSON");
  }
  if (!Array.isArray(parsed) || !parsed.every(isFinding)) {
    throw new Error("lupa: findings.json does not match the finding contract");
  }
  return parsed;
}

function writeFindings(dir: string, findings: Finding[]): void {
  writeFileSync(join(dir, "findings.json"), JSON.stringify(findings, null, 2) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// Finding sanitizing (R7). LLM output and the privileged artifact are untrusted text.
// ---------------------------------------------------------------------------

/** C0 and DEL controls except TAB and LF (kept for multi-line messages and suggestions). */
const CONTROL_KEEP_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f]/g;
/** Every C0 and DEL control, for single-line fields (file, rule). */
const CONTROL_ALL = /[\u0000-\u001f\u007f]/g;

/** Absolute, drive-qualified, or parent-traversing paths are never placed on a diff line. */
function unsafePath(file: string): boolean {
  return (
    file.startsWith("/") ||
    file.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/.test(file) ||
    file.split(/[\\/]/).includes("..")
  );
}

/**
 * Strips control characters, caps lengths, and turns unsafe paths into repository-level notes
 * (general body). Unsafe-path check runs after the control strip, before the length cap.
 *
 * Paths longer than FILE_CAP (200 chars) are intentionally capped and then fall back to general
 * notes: a truncated path matches no diff line, so mapToComments never places it inline.
 */
export function sanitizeFinding(f: Finding): Finding {
  let file = f.file.replace(CONTROL_ALL, "");
  let message = f.message.replace(CONTROL_KEEP_TEXT, "");
  let line = f.line;
  if (file !== "" && unsafePath(file)) {
    message = `artifact path rejected: ${message}`;
    file = "";
    line = undefined;
  }
  const out: Finding = {
    severity: f.severity,
    file: capText(file, FILE_CAP),
    rule: capText(f.rule.replace(CONTROL_ALL, ""), RULE_CAP),
    message: capText(message, MSG_CAP),
  };
  if (line !== undefined) out.line = line;
  if (f.suggestion !== undefined) {
    out.suggestion = capText(f.suggestion.replace(CONTROL_KEEP_TEXT, ""), SUGGESTION_CAP);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Prompt budget (F10). The variable user-message portion of the single-shot
// inference request — fast findings, linked-issue context, and diff together —
// is bounded in UTF-8 bytes (Buffer.byteLength, what actually ships).
// ---------------------------------------------------------------------------

/** Prefix of `s` holding at most `maxBytes` UTF-8 bytes, cut on a code-point boundary. */
function cutToBytes(s: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const ch of s) {
    const bl = Buffer.byteLength(ch, "utf8");
    if (bytes + bl > maxBytes) break;
    bytes += bl;
    end += ch.length;
  }
  return s.slice(0, end);
}

/**
 * Fits the structured prompt regions into `budget` UTF-8 bytes. Cut order:
 * linked-issue context first (truncate with a marker, or drop when the
 * allowance is negative), then whole fast findings from the tail with a
 * re-rendered omitted count; the diff is never cut. Every region is
 * neutralised first, exactly as `buildMessages` renders it, and every
 * measurement runs on the rendered string. Findings objects pass through
 * (only their serialized form is escaped at render); posting and artifacts
 * keep using the full `fast` array, so omitted findings still reach the review.
 */
export function budgetPrompt(
  fast: Finding[],
  promptText: string,
  issueBody: string | undefined,
  skipped: string[],
  budget: number,
  opts?: { withIds?: boolean },
): { fast: Finding[]; promptText: string; issueBody: string | undefined; skipped: string[]; findingsOmitted: number; issueDropped: boolean } {
  const nPrompt = neutralise(promptText);
  const nIssueFull = issueBody !== undefined && issueBody.trim() !== "" ? neutralise(issueBody) : undefined;
  const render = (f: Finding[], ib: string | undefined, omitted: number): string =>
    buildMessages(f, nPrompt, ib, skipped, undefined, omitted, opts).user;

  let curIssue = nIssueFull;
  let issueDropped = false;
  let kept = [...fast];
  let omitted = 0;

  if (Buffer.byteLength(render(kept, curIssue, 0), "utf8") <= budget) {
    return { fast: kept, promptText: nPrompt, issueBody: curIssue, skipped: skipped.map(neutralise), findingsOmitted: 0, issueDropped: false };
  }

  // Step 1: linked-issue context. The allowance is sized once against the full
  // findings set: budget minus everything else plus the fixed cost of carrying
  // any issue text (header, separators, tags, marker — byte-exact, measured on
  // the rendered regions, never estimated).
  if (curIssue !== undefined) {
    const noIssueBytes = Buffer.byteLength(render(kept, undefined, 0), "utf8");
    const markerBytes = Buffer.byteLength(ISSUE_TRUNCATION_MARKER, "utf8");
    const issueOverhead =
      Buffer.byteLength(render(kept, ISSUE_TRUNCATION_MARKER, 0), "utf8") - noIssueBytes - markerBytes;
    const allowance = budget - noIssueBytes - issueOverhead;
    if (allowance < markerBytes) {
      curIssue = undefined;
      issueDropped = true;
    } else if (Buffer.byteLength(curIssue, "utf8") > allowance) {
      curIssue = cutToBytes(curIssue, allowance - markerBytes) + ISSUE_TRUNCATION_MARKER;
    }
  }

  // Step 2: fast-findings overflow. Whole findings dropped from the tail with a
  // re-rendered count — never mid-finding cuts, so the JSON stays parseable.
  while (kept.length > 0 && Buffer.byteLength(render(kept, curIssue, omitted), "utf8") > budget) {
    kept = kept.slice(0, -1);
    omitted += 1;
  }

  return { fast: kept, promptText: nPrompt, issueBody: curIssue, skipped: skipped.map(neutralise), findingsOmitted: omitted, issueDropped };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function fields(env: RunEnv): EventFields {
  return env.payload as EventFields;
}

function triggerFor(env: RunEnv): boolean {
  const p = fields(env);
  return shouldTrigger(env.eventName, {
    action: p.action,
    commentBody: p.comment?.body,
    reviewBody: p.review?.body,
    authorAssociation: p.comment?.author_association ?? p.review?.author_association,
    issueHasPR: p.issue?.pull_request !== undefined,
    prNumber: env.inputs.prNumber,
  });
}

function prNumberFor(env: RunEnv): number | null {
  if (env.eventName === "workflow_dispatch") return env.inputs.prNumber;
  return resolvePrNumber(env.eventName, env.payload as Parameters<typeof resolvePrNumber>[1]);
}

/** Logs a line and, when a summary file exists, appends it there (skip paths must leave evidence).
 * The append is best-effort: an unwritable summary path warns but never throws, so a skip path
 * still exits 0. */
function note(env: RunEnv, out: Outcome, text: string): void {
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

/**
 * Slow path (LLM). Returns undefined when it is skipped: no key, nothing to send, bad config,
 * an absent model, or a failed call. Every skip is a warning; the fast path still posts.
 * The LLM key is intentional API use; the model is given no tools.
 * On success the verdict envelope carries the model's duplicate judgements with links
 * converted to absolute all-list indices; the agent-mode return carries no verdicts (no merge, by design).
 */
async function slowPath(
  env: RunEnv,
  out: Outcome,
  deps: Deps,
  pr: number,
  fast: Finding[],
  promptText: string,
  issueBody: string | undefined,
  skipped: string[],
  prBody: string,
): Promise<{ findings: Finding[]; verdicts?: DedupVerdicts } | undefined> {
  const i = env.inputs;
  if (i.llmApiKey === "") {
    core.info("no llm_api_key: slow path skipped");
    return undefined;
  }
  if (promptText.trim() === "") {
    core.info("no prompt-able files in this change: slow path skipped");
    return undefined;
  }
  if (i.llmModel === "") {
    core.warning("llm_model is empty: slow path skipped");
    return undefined;
  }
  let ep: ResolvedEndpoint;
  try {
    ep = resolveEndpoint({
      llmProvider: i.llmProvider,
      llmBaseUrl: i.llmBaseUrl,
      llmApiStyle: i.llmApiStyle,
      llmPath: i.llmPath,
      llmModel: i.llmModel,
      llmApiKey: i.llmApiKey,
      prNumber: pr,
    });
  } catch (e) {
    core.warning(`slow path skipped: ${(e as Error).message}`);
    return undefined;
  }
  if (i.llmProvider === "ollama") {
    try {
      await deps.analysis.ensureOllama(ep.baseUrl, i.llmModel, { timeoutSeconds: i.timeoutSeconds, apiKey: i.llmApiKey });
    } catch (e) {
      core.warning(`slow path skipped: ${(e as Error).message}`);
      return undefined;
    }
  }
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
  const promptFast = fast.map(sanitizeFinding);
  const b = budgetPrompt(promptFast, promptText, issueBody, skipped, i.maxPromptChars, { withIds: !i.llmAgent });
  const messages = buildMessages(
    b.fast,
    b.promptText,
    b.issueBody,
    b.skipped,
    i.llmAgent ? { maxTurns: i.llmAgentMaxTurns } : undefined,
    b.findingsOmitted,
    { withIds: !i.llmAgent },
  );
  const promptBytes = Buffer.byteLength(messages.user, "utf8");
  if (promptBytes > i.maxPromptChars) {
    core.warning(`prompt ${promptBytes} exceeds max_prompt_chars ${i.maxPromptChars} after bounded cuts`);
    note(env, out, `lupa: prompt ${promptBytes} exceeds max_prompt_chars ${i.maxPromptChars} after bounded cuts — LLM review skipped, gate uses fast findings only.`);
    return undefined;
  }
  if (b.issueDropped) {
    core.info(`linked issue context dropped to fit the ${i.maxPromptChars}-byte prompt budget`);
  }
  const llmOpts = {
    model: i.llmModel,
    apiKey: i.llmApiKey,
    temperature: i.llmTemperature,
    topP: i.llmTopP,
    maxTokens: i.llmMaxTokens,
    timeoutSeconds: i.timeoutSeconds,
    provider: i.llmProvider,
    prNumber: pr,
    // R3: only the user's llm_base_url input may trigger the rewrite warning —
    // a preset-derived base rebuilt during the probe must stay silent.
    userBase: i.llmBaseUrl !== "",
  };
  // Spec §9.5: plain `auto` (no llm_path override) is error-driven — the probe
  // walks the styles and learns from 400/404. An explicit llm_api_style — and
  // any llm_path override, which pins the path the probe would rebuild — is
  // honored as-is through the resolved endpoint, with no probing.
  if (i.llmAgent) {
    const selfRepo = String((env.payload.repository as { full_name?: unknown } | undefined)?.full_name ?? "");
    const linked = parseLinkedRepos(prBody, selfRepo);
    if (linked.length > 0) core.info(`agent linked repositories: ${linked.join(", ")}`);
    const toolCtx: ToolContext = {
      roots: { self: env.workDir, linked: new Map() },
      ensureLinked: async (alias, opts?) => {
        if (!linked.some((l) => l.toLowerCase() === alias.toLowerCase()))
          return { error: "repository not accessible: " + alias };
        const r = await ensureLinkedRepo(alias, {
          token: i.githubToken,
          baseDir: join(process.env.RUNNER_TEMP ?? tmpdir(), "lupa-linked"),
          maxBytes: AGENT_LIMITS.cloneMaxBytes,
          deadlineMs: opts?.deadlineMs,
          sizeKb: async (a) => {
            const parts = a.split("/");
            if (parts.length !== 2) return undefined;
            const [o, n] = parts;
            return deps.gh.getRepoSize(o!, n!);
          },
        });
        if ("dir" in r) {
          toolCtx.roots.linked!.set(alias, r.dir);
          if ("sha" in r && r.sha !== "") core.info(`agent linked repo ${alias} at ${r.sha}`);
        }
        return r;
      },
    };
    const conv: Conversation = {
      ...messages,
      tools: [...TOOL_DEFS],
    };
    if (linked.length > 0)
      conv.turns = [
        {
          role: "user",
          text:
            "Linked repositories mentioned in this pull request: " +
            linked.join(", ") +
            ". You may inspect them with the repo parameter of the read-only tools.",
        },
      ];
    const agentOpts = { ...llmOpts, maxTurns: i.llmAgentMaxTurns, maxSeconds: i.llmAgentMaxSeconds };
    const res: LlmResult =
      i.llmApiStyle === "auto" && i.llmPath === ""
        ? await deps.analysis.callWithProbeAgent(
            i.llmProvider,
            i.llmModel,
            ep.baseUrl,
            i.llmApiKey,
            conv,
            agentOpts,
            toolCtx,
          )
        : await deps.analysis.callByStyleAgent(ep, conv, agentOpts, toolCtx);
    if (!res.ok) {
      core.warning(`slow path failed (${res.reason}): ${res.detail}`);
      return undefined;
    }
    return { findings: res.findings };
  }
  const res: LlmResult =
    i.llmApiStyle === "auto" && i.llmPath === ""
      ? await deps.analysis.callWithProbe(i.llmProvider, i.llmModel, ep.baseUrl, i.llmApiKey, messages, llmOpts)
      : await deps.analysis.callByStyle(ep, messages, llmOpts);
  if (!res.ok) {
    core.warning(`slow path failed (${res.reason}): ${res.detail}`);
    return undefined;
  }
  const verdicts = res.verdicts;
  if (verdicts === undefined) return { findings: res.findings };
  // Links convert to absolute all-list indices against the UNCUT fast list (never b.fast.length).
  // Verdicts naming a cut-tail sent index (≥ b.fast.length) name findings the model never saw:
  // dropped whole and counted as malformed. All findings are kept regardless.
  const kept = b.fast.length;
  let malformed = verdicts.malformed;
  const pairs: Array<[number, number]> = [];
  for (const [a, c] of verdicts.pairs) {
    if (c >= kept || a >= kept) malformed += 1;
    else pairs.push([a, c]);
  }
  const links: Array<[number, number]> = [];
  for (const [r, s] of verdicts.links) {
    if (s >= kept) malformed += 1;
    else links.push([fast.length + r, s]);
  }
  if (malformed > 0) core.warning(`lupa: ignored ${malformed} malformed dedup verdict(s)`);
  return { findings: res.findings, verdicts: { pairs, links, malformed } };
}

// Artifact redaction is runtime-key masking only: the run's own github_token and
// llm_api_key values are masked from findings.json and sarif.json. Secrets
// committed in the diff are a separate scanner concern and are not covered.
function runtimeSecrets(env: RunEnv): string[] {
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
 * continuation lines). When the general section is empty the block carries its
 * heading; otherwise it continues the existing list.
 */
function foldExcessInline(withHeading: boolean, excess: InlineComment[]): string {
  const items = excess.map((c) => {
    const text = c.body.replace(/\r\n?/g, "\n").replace(/(\n[ \t]*)+$/, "");
    const head = `- ${c.path}:${c.line}`;
    if (text.trim() === "") return head;
    return `${head}\n  ${text.replace(/\n/g, "\n  ")}`;
  });
  return withHeading ? `\n\n**Findings not placed inline:**\n${items.join("\n")}` : `\n${items.join("\n")}`;
}

/**
 * Posts one review for `headSha`, or dry-runs it. Writes the summary in every case. Posts only
 * when the token can write and the PR head still equals `headSha` (checked via the API).
 * A failed issue fallback is a warning; it never changes the exit code.
 */
async function publishReview(a: PublishArgs): Promise<void> {
  const fullSet = redactFindings(a.findings, runtimeSecrets(a.env));
  const inputs = a.env.inputs;
  // Dedup merge before the funnel. Gate inputs keep the full pre-merge set (provably
  // identical outcomes); the funnel — top-N, inline, body — runs on the merged set, and
  // omission counts reflect the post-merge cut (merged-away findings are represented, never omitted).
  const { merged, dropped } =
    a.verdicts === undefined ? { merged: fullSet, dropped: 0 } : mergeDuplicates(fullSet, a.verdicts);
  if (dropped > 0) core.warning(`lupa: ignored ${dropped} unmergeable dedup verdict(s)`);
  // Publication funnel: top-N by severity, then the inline cap (excess folds
  // to the body), then the body char cap. Gates keep the full pre-cap set.
  const ordered = prioritizeFindings(merged);
  const retained = ordered.slice(0, inputs.maxFindings);
  const omitted = merged.length - retained.length;
  const omissionMarker = omitted > 0 ? omissionMarkerFor(omitted, inputs.maxFindings) : undefined;
  const { inline, general } = mapToComments(retained, parseHunks(a.hunks));
  const postedInline = inline.slice(0, inputs.maxInlineComments);
  const excessInline = inline.slice(inputs.maxInlineComments);
  let body = buildBody(general, summaryFor(fullSet));
  if (excessInline.length > 0) body += foldExcessInline(general.length === 0, excessInline);
  const capped = capBody(body, inputs.maxReviewBodyChars, omissionMarker === undefined ? [] : [omissionMarker]);
  const payload: ReviewPayload = {
    commit_id: a.headSha,
    body: capped,
    event: eventFor(inputs.failLevel, fullSet),
    comments: postedInline,
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
        `inline=${postedInline.length}, general=${general.length + excessInline.length}, high=${high}, omitted=${omitted})`,
    );
    return;
  }
  const canWrite = !a.isFork || a.env.tokenType === "app" || a.env.tokenType === "workflow-run";
  if (!canWrite) {
    core.warning("fork PR with a read-only token: review not posted; summary and artifact only");
    return;
  }
  const live = await a.deps.gh.getPr(a.pr);
  if (live.headSha !== a.headSha) {
    core.warning(`PR head moved from ${a.headSha} to ${live.headSha}: skipping review for the stale head`);
    return;
  }
  try {
    await a.deps.gh.createReview(a.pr, payload, { canWrite: true, maxBodyChars: inputs.maxReviewBodyChars });
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
      return;
    }
    if (!(e instanceof ReadonlyTokenError)) throw e;
    core.error(`review post refused by GitHub: ${e.detail !== "" ? e.detail : e.message}`);
    // issuesWrite is derived from the environment: the template grants issues: write explicitly.
    // A live token-scope check is out of scope; an API refusal still degrades to a warning below.
    const issuesWrite = a.env.issueFallback && canWrite;
    if (!issuesWrite) {
      core.warning("issue fallback unavailable (not enabled, or token lacks issues: write); nothing posted");
      return;
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
}

/**
 * SARIF 2.1.0 for code scanning: warning and high findings only (info stays in the review and the
 * artifact), and only findings with a safe repository path (code scanning needs a location).
 */
export function toSarif(findings: Finding[]): unknown {
  const level = (s: Finding["severity"]): string => (s === "high" ? "error" : s === "warning" ? "warning" : "note");
  const results = findings
    .filter((f) => f.severity !== "info" && f.file !== "" && !unsafePath(f.file))
    .map((f) => ({
      ruleId: f.rule,
      level: level(f.severity),
      message: { text: f.message },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: f.file },
            ...(f.line !== undefined ? { region: { startLine: f.line } } : {}),
          },
        },
      ],
    }));
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [{ tool: { driver: { name: "pr-reviewer" } }, results }],
  };
}

/** Fluxo A: pull_request / issue_comment / review / dispatch. The diff comes from the template. */
async function runFlowA(env: RunEnv, deps: Deps, out: Outcome): Promise<void> {
  out.slowPathSkipped = true;
  if (!triggerFor(env)) {
    note(env, out, `lupa: event "${env.eventName}" does not trigger a review; nothing to do.`);
    return;
  }
  const pr = prNumberFor(env);
  if (pr === null) {
    note(env, out, "lupa: no pull request for this event; nothing to review.");
    return;
  }
  requireSha("PR_REVIEWER_BASE_SHA", env.baseSha);
  requireSha("PR_REVIEWER_HEAD_SHA", env.headSha);

  // Unfiltered list: L0 needs lockfiles and binaries (Task 4 contract).
  const files = parseDiffFiles(readDiff(env.artifactDir), env.workDir);
  const pull = await deps.gh.getPr(pr);
  const meta: PrMeta = {
    pr_number: pr,
    head_sha: env.headSha,
    base_sha: env.baseSha,
    head_repo_full_name: pull.headRepo,
    is_fork: pull.isFork,
  };
  writePrMeta(meta, env.artifactDir);

  const changedNames = new Set(files.map((f) => basename(f.file)));
  const l0 = runL0(files, {
    hasManifestFor: (lock) => {
      const manifest = MANIFEST_FOR[lock];
      return manifest === undefined || changedNames.has(manifest);
    },
  });
  const lockfiles = files.filter((f) => isLockfile(f.file)).map((f) => f.file);

  // Scanners and L2 run PR-controlled code: scrubbed env. The semgrep token is never passed
  // here, so semgrep always runs in `scan` mode (a secret never reaches PR code).
  // Fork PR with secrets in scope (non-pull_request trigger, writable App token, or LLM key):
  // L2 toolchains (linters, build tooling) would execute PR-controlled config with secrets nearby,
  // so they are skipped. Trusted, data-driven scanners still run.
  const forkWithSecrets =
    pull.isFork && (env.eventName !== "pull_request" || env.tokenType === "app" || env.inputs.llmApiKey !== "");
  const { scan, l2 } = await withScrubbedEnv(async () => {
    const s = await deps.analysis.runScanners({
      dir: env.workDir,
      baselineSha: env.baseSha,
      hasSemgrepToken: false,
      sbom: true,
      lockfiles,
      outDir: env.artifactDir,
      maxArtifactBytes: env.inputs.maxArtifactBytes,
    });
    if (forkWithSecrets) {
      core.warning("fork PR with secrets in scope: L2 native toolchains skipped");
      return { scan: s, l2: [L2_SKIPPED] };
    }
    const l = await deps.analysis.runL2(env.workDir, new Set(files.map((f) => f.file)));
    return { scan: s, l2: l };
  });
  if (scan.sbomPath !== undefined) {
    try {
      copyFileSync(scan.sbomPath, join(env.artifactDir, "sbom.cdx.json"));
    } catch (e) {
      core.warning(`sbom not copied to the artifact: ${(e as Error).message}`);
    } finally {
      rmSync(dirname(scan.sbomPath), { recursive: true, force: true });
    }
  }
  const fast = [...l0, ...scan.findings, ...l2];
  // Written before the LLM call so a later failure still leaves the fast results uploadable.
  writeFindings(env.artifactDir, redactFindings(fast, runtimeSecrets(env)));

  const prompt = truncateDiff(filterForPrompt(files), env.inputs.maxDiffChars, PER_FILE_CAP);
  let issueBody: string | undefined;
  const issueNo = linkedIssueNumber(pull.body);
  if (issueNo !== null) {
    try {
      issueBody = await deps.gh.getIssueBody(issueNo);
      out.issueBodyFetched = issueNo;
    } catch (e) {
      core.warning(`linked issue #${issueNo} not fetched: ${(e as Error).message}`);
    }
  }

  const llm = await slowPath(env, out, deps, pr, fast, prompt.text, issueBody, prompt.skipped, pull.body);
  if (llm === undefined) {
    note(env, out, "lupa: dedup skipped (slow path unavailable); scanner findings published unmerged");
  }
  out.slowPathSkipped = llm === undefined;
  out.findingsFrom = llm === undefined ? "fastpath" : "llm";
  // No judge ran (no LLM): the verdicts key still lands on pr-meta as the empty object.
  // Agent runs carry no verdicts and merge nothing, by design.
  const verdicts: DedupVerdicts | undefined =
    llm === undefined ? { pairs: [], links: [], malformed: 0 } : llm.verdicts;
  const all = [...fast, ...(llm?.findings ?? [])].map(sanitizeFinding);
  const redacted = redactFindings(all, runtimeSecrets(env));
  writeFindings(env.artifactDir, redacted);
  writePrMeta(verdicts === undefined ? meta : { ...meta, verdicts }, env.artifactDir);
  // SARIF is a publication surface: the same pure merge over the same inputs as the funnel.
  const { merged: sarifSet } = verdicts === undefined ? { merged: redacted } : mergeDuplicates(redacted, verdicts);
  writeFileSync(join(env.artifactDir, "sarif.json"), JSON.stringify(toSarif(sarifSet), null, 2) + "\n", "utf8");

  await publishReview({ env, deps, out, pr, isFork: pull.isFork, findings: all, hunks: files, headSha: env.headSha, verdicts });
  if (!out.staleSkipped) out.exitCode = exitFor(env.inputs.failLevel, all);
}

/**
 * Fluxo B: workflow_run, privileged. Only reads the PR run's artifact and posts. It never checks
 * out code, runs scanners or calls the LLM. The artifact came from a run that executed PR code,
 * so it is bound to the trusted workflow_run fields and to the live PR (repo, head SHA, branch).
 */
async function runFlowB(env: RunEnv, deps: Deps, out: Outcome): Promise<void> {
  out.slowPathSkipped = true;
  // Sanitizing pass for the privileged flow (Flow A sanitizes in runFlowA; publishReview does not sanitize).
  const meta = readPrMeta(env.artifactDir, env.inputs.maxArtifactBytes);
  if (meta === undefined) {
    throw new Error(
      `lupa: pr-meta.json not found in ${env.artifactDir}; refusing to post without the PR run's artifact`,
    );
  }
  const wr = fields(env).workflow_run;
  const runRepo = wr?.head_repository?.full_name;
  const runBranch = wr?.head_branch;
  if (wr?.head_sha === undefined || runRepo === undefined || runRepo === "" || runBranch === undefined) {
    throw new Error("lupa: workflow_run head context is incomplete; refusing to post");
  }
  // Lowercase at the binding site: readPrMeta accepts either case, the API returns lowercase.
  const headSha = meta.head_sha.toLowerCase();
  if (headSha !== wr.head_sha.toLowerCase()) {
    throw new Error("lupa: artifact head_sha does not match workflow_run.head_sha; refusing to post");
  }
  // The PR comes from trusted event fields, never from the artifact: exactly one open PR must
  // have this head (repo + branch), and the artifact's pr_number must name that same PR.
  const prs = await deps.gh.findPrsByHead(runRepo, runBranch);
  if (prs.length !== 1) {
    throw new Error(
      `lupa: expected exactly one open PR for ${runRepo}:${runBranch}, found ${prs.length}; refusing to post`,
    );
  }
  const pr = prs[0];
  if (pr !== meta.pr_number) {
    throw new Error("lupa: artifact pr_number does not match the PR derived from workflow_run; refusing to post");
  }
  const live = await deps.gh.getPr(pr);
  if (live.headRepo !== runRepo) {
    throw new Error("lupa: PR head repository does not match workflow_run.head_repository; refusing to post");
  }
  if (live.headSha.toLowerCase() !== headSha) {
    throw new Error("lupa: live PR head does not match workflow_run.head_sha; refusing to post");
  }
  if (live.headRef !== runBranch) {
    throw new Error("lupa: PR head branch does not match workflow_run.head_branch; refusing to post");
  }
  const findings = readFindings(env.artifactDir, env.inputs.maxArtifactBytes).map(sanitizeFinding);
  const hunks = parseDiffFiles(readDiff(env.artifactDir));
  // A missing verdicts key means no judge ran: silent no-merge. Out-of-range indices
  // range-check inside the publishReview merge (dropped with the count).
  await publishReview({ env, deps, out, pr, isFork: live.isFork, findings, hunks, headSha, verdicts: meta.verdicts });
  if (!out.staleSkipped) out.exitCode = exitFor(env.inputs.failLevel, findings);
}

/** Runs one review. Returns the outcome; main() maps exitCode to the process. */
export async function run(env: RunEnv, deps: Deps): Promise<Outcome> {
  const out = newOutcome();
  if (env.eventName === "workflow_run") await runFlowB(env, deps, out);
  else await runFlowA(env, deps, out);
  return out;
}

function realGateway(token: string): Gateway {
  // Lazy (M12): the client is built on first use, so a non-triggering run never needs a token.
  let client: ReturnType<typeof getOctokit> | undefined;
  const octokit = (): ReturnType<typeof getOctokit> => (client ??= getOctokit(token));
  return {
    async getPr(pr) {
      const { owner, repo } = context.repo;
      const r = await octokit().rest.pulls.get({ owner, repo, pull_number: pr });
      const headRepo = r.data.head.repo?.full_name ?? "";
      return {
        body: r.data.body ?? "",
        headSha: r.data.head.sha,
        headRepo,
        headRef: r.data.head.ref,
        isFork: headRepo !== r.data.base.repo.full_name,
      };
    },
    async findPrsByHead(headRepo, headRef) {
      const { owner, repo } = context.repo;
      const headOwner = headRepo.split("/")[0];
      const prs = await octokit().paginate(octokit().rest.pulls.list, {
        owner,
        repo,
        state: "open",
        head: `${headOwner}:${headRef}`,
        per_page: 100,
      });
      return prs
        .filter(
          (p) =>
            p.head.repo?.full_name === headRepo && p.head.ref === headRef && p.base.repo.full_name === `${owner}/${repo}`,
        )
        .map((p) => p.number);
    },
    async getIssueBody(issue) {
      const { owner, repo } = context.repo;
      const r = await octokit().rest.issues.get({ owner, repo, issue_number: issue });
      return r.data.body ?? "";
    },
    getRepoSize: (owner, repo) => fetchRepoSize(octokit(), owner, repo),
    createReview: (pr, payload, opts) =>
      postReview(octokit(), pr, payload, { canWrite: opts.canWrite, maxBodyChars: opts.maxBodyChars }).then(() => undefined),
    createIssueComment: (pr, body, opts) => postIssueFallback(octokit(), { pr, body, ...opts }),
  };
}

function realAnalysis(): Analysis {
  return {
    runScanners,
    runL2: (dir, changedFiles) => runL2(dir, undefined, undefined, changedFiles),
    ensureOllama,
    checkModelListed,
    // Explicit styles (and llm_path overrides) dispatch straight to the resolved
    // endpoint's adapter; plain `auto` goes through the error-driven probe
    // (spec §9.5), which logs the style that won.
    callByStyle,
    callWithProbe: async (provider, model, baseUrl, apiKey, messages, o) => {
      const { result, via } = await callWithProbe(provider, model, baseUrl, apiKey, messages, o);
      if (via !== undefined) core.info(`llm api style: ${via}`);
      return result;
    },
    callByStyleAgent: async (ep, conv, o, toolCtx) => {
      const result = await runStyleAgent(ep, conv, o, toolCtx);
      core.info(`llm api style: ${ep.apiStyle}`);
      return result;
    },
    callWithProbeAgent: async (provider, model, baseUrl, apiKey, conv, o, toolCtx) => {
      const { result, via } = await runProbeAgent(provider, model, baseUrl, apiKey, conv, o, toolCtx);
      if (via !== undefined) core.info(`llm api style: ${via}`);
      return result;
    },
  };
}

/** Reads the real environment. Throws on invalid action inputs. */
export function readRunEnv(): RunEnv {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const payload: Record<string, unknown> =
    eventPath !== undefined && eventPath !== ""
      ? (JSON.parse(readFileSync(eventPath, "utf8")) as Record<string, unknown>)
      : {};
  const inputs = getInputs();
  const value = process.env.PR_REVIEWER_TOKEN_TYPE;
  const tokenType = value === 'app' ? 'app' : value === 'workflow-run' ? 'workflow-run' : 'github-token';
  return {
    eventName: process.env.GITHUB_EVENT_NAME ?? "",
    payload,
    inputs,
    workDir: process.env.GITHUB_WORKSPACE ?? process.cwd(),
    artifactDir: process.env.PR_REVIEWER_ARTIFACT_DIR ?? join(process.env.RUNNER_TEMP ?? tmpdir(), "pr-reviewer-out"),
    baseSha: process.env.PR_REVIEWER_BASE_SHA ?? "",
    headSha: process.env.PR_REVIEWER_HEAD_SHA ?? "",
    tokenType,
    issueFallback: process.env.PR_REVIEWER_ISSUE_FALLBACK === "true",
    ...(process.env.GITHUB_STEP_SUMMARY ? { summaryPath: process.env.GITHUB_STEP_SUMMARY } : {}),
  };
}

export async function main(): Promise<void> {
  const env = readRunEnv();
  const out = await run(env, { gh: realGateway(env.inputs.githubToken), analysis: realAnalysis() });
  core.setOutput("exit-code", String(out.exitCode));
  process.exitCode = out.exitCode;
}

const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntry) {
  main().catch((err: unknown) => {
    core.setFailed(err instanceof Error ? err.message : String(err));
  });
}
