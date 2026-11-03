import { createRequestContext } from "../runtime/context.js";
import * as core from "@actions/core";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunEnv, Outcome, Deps } from "./contracts.js";
import type { Finding } from "../domain/finding.js";
import type { AnalysisAssessment, StageResult } from "../domain/assessment.js";
import { sanitizeFinding } from "../domain/finding.js";
import type { DedupVerdicts, LlmResult } from "../llm/types.js";
import { TOOL_DEFS, type ToolContext } from "../agent-tools.js";
import { AGENT_LIMITS, type Conversation } from "../agent-types.js";
import { catalogProtocolFor, resolveEndpoint, type ResolvedEndpoint } from "../providers.js";
import { ensureLinkedRepo, parseLinkedRepos, sameOwner } from "../linked-repos.js";
import { buildMessages, ISSUE_TRUNCATION_MARKER } from "../prompt.js";
import { budgetPrompt } from "../prompt/budget.js";
import { note } from "./publish.js";

/**
 * Slow path (LLM). Returns undefined when it is skipped: no key, nothing to send, bad config,
 * an absent model, or a failed call. Every skip is a warning; the fast path still posts.
 * The LLM key is intentional API use; the model is given no tools.
 * On success the verdict envelope carries the model's duplicate judgements with links
 * converted to absolute all-list indices; the agent-mode return carries no verdicts (no merge, by design).
 */
export async function slowPath(
  env: RunEnv,
  out: Outcome,
  deps: Deps,
  pr: number,
  fast: Finding[],
  promptText: string,
  issueBody: string | undefined,
  skipped: string[],
  prBody: string,
  assessment?: AnalysisAssessment,
): Promise<{ findings: Finding[]; verdicts?: DedupVerdicts } | undefined> {
  const i = env.inputs;
  const semantic: StageResult = { stage: "semantic", applicable: true, required: assessment?.scope !== "deterministic", status: "skipped", reason: "not-executed" };
  assessment?.stages.push(semantic);
  const unavailable = (reason: string, status: StageResult["status"] = "unsupported") => {
    semantic.status = status; semantic.reason = reason;
  };
  const observed = (r: LlmResult) => {
    if (!r.ok) { unavailable(`${r.reason}: ${r.detail}`, r.reason === "no-key" || r.reason === "unsupported" ? "unsupported" : "failed"); return; }
    if (!r.execution) { unavailable("unknown-health"); return; }
    unavailable(r.execution.reason ?? r.execution.status,
      r.execution.status === "completed" ? "ok" : r.execution.status === "fallback" ? "unsupported" : r.execution.status === "budget" ? "skipped" : "failed");
    if (i.llmAgent && r.execution.mode !== "agent") unavailable("tools-unsupported");
  };
  /** One aggregate-usage line when the consumed result observed usage; silent otherwise. */
  const noteUsage = (result: LlmResult): void => {
    if (result.ok && result.usage !== undefined) {
      const u = result.usage;
      note(env, out, `lupa: llm usage input=${u.input} output=${u.output} tokens (calls=${u.calls})`);
    }
  };
  if (i.llmApiKey === "") {
    unavailable("no-key; semantic review did not run", semantic.required ? "unsupported" : "skipped");
    core.info("no llm_api_key: slow path skipped");
    return undefined;
  }
  if (promptText.trim() === "") {
    semantic.applicable = false; semantic.reason = "no-prompt-eligible-content";
    core.info("no prompt-able files in this change: slow path skipped");
    return undefined;
  }
  if (i.llmModel === "") {
    unavailable("missing-model");
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
    unavailable(`invalid-endpoint: ${(e as Error).message}`);
    core.warning(`slow path skipped: ${(e as Error).message}`);
    return undefined;
  }
  if (i.llmProvider === "ollama") {
    try {
      await deps.analysis.ensureOllama(ep.baseUrl, i.llmModel, { timeoutSeconds: i.timeoutSeconds, apiKey: i.llmApiKey });
    } catch (e) {
      unavailable(`model-setup: ${(e as Error).message}`, "failed");
      core.warning(`slow path skipped: ${(e as Error).message}`);
      return undefined;
    }
  }
  const check = await deps.analysis.checkModelListed(
    ep.baseUrl, i.llmModel, i.llmApiKey, catalogProtocolFor(i.llmProvider, ep.apiStyle),
  );
  if (check.status === "absent") {
    unavailable("model-not-listed");
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
    unavailable("prompt-budget", "skipped");
    core.warning(`prompt ${promptBytes} exceeds max_prompt_chars ${i.maxPromptChars} after bounded cuts`);
    note(env, out, `lupa: prompt ${promptBytes} exceeds max_prompt_chars ${i.maxPromptChars} after bounded cuts — LLM review skipped, gate uses fast findings only.`);
    return undefined;
  }
  if (b.issueDropped) {
    core.info(`linked issue context dropped to fit the ${i.maxPromptChars}-byte prompt budget`);
  }
  if (issueBody !== undefined && (b.issueDropped || b.issueBody?.endsWith(ISSUE_TRUNCATION_MARKER))) {
    assessment?.coverage.issues.push({ code: "issue-context", message: "Linked issue context was truncated or omitted by the prompt budget." });
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
    const owned = createRequestContext(i.llmAgentMaxSeconds * 1000);
    try {
      const selfRepo = String((env.payload.repository as { full_name?: unknown } | undefined)?.full_name ?? "");
      const linked = parseLinkedRepos(prBody, selfRepo);
      if (linked.length > 0) core.info(`agent linked repositories: ${linked.join(", ")}`);
      const toolCtx: ToolContext = {
        // Recoverable lookup errors (wrong path, bad regex) are the model's routine
        // exploration and leave diff coverage intact; cancellation, I/O and budget
        // failures and every truncation are real coverage gaps.
        observe: event => {
          if (event.isError && !event.recoverable) assessment?.coverage.issues.push({ code: "tool-error", message: `${event.tool}: inspection failed` });
          else if (event.truncated) assessment?.coverage.issues.push({ code: "tool-truncated", message: `${event.tool}: inspection truncated` });
        },
        roots: { self: env.workDir, linked: new Map() },
        ensureLinked: async (alias, opts?) => {
          if (!linked.some((l) => l.toLowerCase() === alias.toLowerCase()))
            return { error: "repository not accessible: " + alias };
          // The PR body is author-controlled: the action's token (and its size lookup)
          // reaches only the reviewed owner's repositories. Other owners clone anonymously.
          const ownCredentials = sameOwner(alias, selfRepo);
          if (!ownCredentials) core.info(`agent linked repo ${alias} cloned without credentials (different owner)`);
          const r = await ensureLinkedRepo(alias, {
            token: ownCredentials ? i.githubToken : "",
            baseDir: join(process.env.RUNNER_TEMP ?? tmpdir(), "lupa-linked"),
            maxBytes: AGENT_LIMITS.cloneMaxBytes,
            deadlineMs: opts?.deadlineMs,
            context: opts?.context ?? owned.context,
            ...(ownCredentials ? {
              sizeKb: async (a: string, options?: { signal?: AbortSignal }) => {
                const parts = a.split("/");
                if (parts.length !== 2) return undefined;
                const [o, n] = parts;
                return deps.gh.getRepoSize(o!, n!, options);
              },
            } : {}),
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
      const agentOpts = { ...llmOpts, context: owned.context, maxTurns: i.llmAgentMaxTurns, maxSeconds: i.llmAgentMaxSeconds };
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
      observed(res);
      if (!res.ok) {
        core.warning(`slow path failed (${res.reason}): ${res.detail}`);
        return undefined;
      }
      noteUsage(res);
      return { findings: res.findings };
    } finally {
      owned.dispose();
    }
  }
  const res: LlmResult =
    i.llmApiStyle === "auto" && i.llmPath === ""
      ? await deps.analysis.callWithProbe(i.llmProvider, i.llmModel, ep.baseUrl, i.llmApiKey, messages, llmOpts)
      : await deps.analysis.callByStyle(ep, messages, llmOpts);
  observed(res);
  if (!res.ok) {
    core.warning(`slow path failed (${res.reason}): ${res.detail}`);
    return undefined;
  }
  const verdicts = res.verdicts;
  if (verdicts === undefined) {
    noteUsage(res);
    return { findings: res.findings };
  }
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
  noteUsage(res);
  return { findings: res.findings, verdicts: { pairs, links, malformed } };
}
