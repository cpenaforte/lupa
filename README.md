# Lupa

A reusable GitHub Action (TypeScript, Node 24) that reviews pull requests in two layers and posts the result as one review:

- **Fast-path (always, free, any language):** diff statistics, sensitive paths, secret detection (gitleaks), TODO/FIXME markers, lockfile changes without a manifest, and scanners (semgrep, gitleaks, trivy, osv-scanner). Optional L2 native toolchains run only when the repository already has their config.
- **Slow-path (optional, bring your own key):** an LLM reviews the diff. It runs only when `llm_api_key` is set. Without a key it is skipped with a warning and the fast-path result is posted.

The diff is treated as untrusted data. By default the LLM has no tools (see Agent mode for the opt-in tool loop) and its output is validated against a schema before anything is posted.

## Quick start

1. Pin the action to a released commit SHA (never a branch) and copy a template into your repository:

   ```bash
   mkdir -p .github/workflows
   cp docs/workflow-template.yml .github/workflows/lupa.yml
   ```

   Replace `OWNER` and the all-zero SHA in the template with a released `lupa` commit.

2. Add secrets and variables to the repository:

   | Name | Kind | Purpose |
   |---|---|---|
   | `LLM_API_KEY` | secret | Key for the LLM provider. Omit it to run fast-path only. |
   | `PR_REVIEWER_MODEL` | variable | Model name. Must belong to the provider set in the template's `llm_provider`. |
   | `PR_REVIEWER_APP_ID` / `PR_REVIEWER_APP_KEY` | variable / secret | Only for fork PRs with the privileged template (see below). |

   The template defaults to `llm_provider: openai`, so provider and model must match. To use OpenCode Go, set `llm_provider: opencode-go` in the template **and** set `PR_REVIEWER_MODEL` to a Go model such as `deepseek-v4-flash`. If you keep `openai`, use an OpenAI model.

3. Open a pull request. The review is posted for `opened`, `synchronize`, `reopened` and `ready_for_review`. You can also comment `/review` on a PR (trusted author associations only) or run `workflow_dispatch` with `pr_number`.

## Inputs

| Input | Default | Meaning |
|---|---|---|
| `github_token` | `${{ github.token }}` | Reads the diff and posts the review. |
| `llm_provider` | `openai` | `openai`, `anthropic`, `google`, `groq`, `mistral`, `openrouter`, `ollama`, `opencode-zen`, `opencode-go`, `custom`. |
| `llm_base_url` | (preset) | Overrides the preset base URL. Required for `custom`. |
| `llm_api_style` | `auto` | `auto`, `openai-chat`, `openai-responses`, `anthropic-messages`, `google-models`, `custom-path`. See API styles below. |
| `llm_path` | (preset) | Path override only (experimental, path-only). Query strings and fragments are dropped with a warning. |
| `llm_model` | (empty) | Model name, passed through as is. |
| `llm_api_key` | (empty) | Provider key. Never logged. |
| `llm_temperature`, `llm_top_p` | (unset) | Sent only when set explicitly. Left unset by default because reasoning models reject other values. |
| `llm_max_tokens` | `2000` | Maximum output tokens. |
| `llm_agent` | `false` | Enable read-only repository tools so the reviewer can verify claims before reporting. |
| `llm_agent_max_turns` | `10` | Maximum number of tool-call rounds the agent may take. |
| `llm_agent_max_seconds` | `180` | Wall-clock budget in seconds for the agent tool loop. |
| `pr_number` | (empty) | Used only by `workflow_dispatch`. |
| `fail_level` | `warning` | `none`, `warning` or `high`. See the gate section. |
| `max_diff_chars` | `60000` | Diff ceiling sent to the LLM. |
| `max_prompt_chars` | `120000` | Total UTF-8 byte budget for the assembled LLM user message (diff, findings, issue context, headers, skipped-files note); the fixed system prompt is excluded. Note: `max_diff_chars` is counted in UTF-16 code units, not bytes. |
| `max_findings` | `200` | Total findings published (inline + body). |
| `max_inline_comments` | `30` | Inline comments posted per review. |
| `max_review_body_chars` | `60000` | Maximum review body size in Unicode code points. |
| `max_artifact_bytes` | `8388608` | Maximum bytes read from SARIF, SBOM, findings, and pr-meta artifacts. |
| `post_comment` | `true` | `false` makes a dry-run. |
| `timeout_seconds` | `90` | LLM request timeout. A timeout degrades to a summary without retry. |

Output: `exit-code` (`0` pass, `2` warning findings, `1` high-severity findings).

## Providers

The default wire format is `openai-chat`: `POST {base_url}/chat/completions` with the JSON-schema `response_format` where the provider accepts it. Anthropic-compatible presets omit `response_format` and parse the output manually. Sampling on Anthropic-compatible endpoints is restricted: `temperature`, `top_p` and `n` are sent only when you set them explicitly, and they are validated per model family (for example, `n` must be 1, and `temperature` and `top_p` cannot be set together). Invalid combinations fail before the request is sent. `llm_api_style` can select a native adapter instead of chat; see API styles below.

| `llm_provider` | Base URL (preset) | Default and native API styles |
|---|---|---|
| `openai` | `https://api.openai.com/v1` | `openai-chat`; `openai-responses` is also native there. Reasoning models (GPT-5/6, o-series) take their own token field and only the default temperature. |
| `anthropic` | `https://api.anthropic.com/v1` | `openai-chat` via the OpenAI-compatible layer; native `/messages` with `anthropic-messages`. |
| `google` | `https://generativelanguage.googleapis.com/v1beta/openai` | `openai-chat` via the OpenAI-compatible layer; native `models/<id>:generateContent` with `google-models`. |
| `groq` | `https://api.groq.com/openai/v1` | `openai-chat`. |
| `mistral` | `https://api.mistral.ai/v1` | `openai-chat`. |
| `openrouter` | `https://openrouter.ai/api/v1` | `openai-chat`. Model slugs look like `author/model`. |
| `ollama` | `http://localhost:11434/v1` | `openai-chat`. Needs a daemon in the job (`services:` or a setup step), a healthcheck, `ollama pull <model>` before the run, `llm_api_key: dummy`, and no strict schema. |
| `opencode-zen` | `https://opencode.ai/zen/v1` | With `auto`, the probe tries `openai-chat` first and falls through to `anthropic-messages`, `openai-responses` or `google-models` on a 400/404 (see API styles below). Nothing is hardcoded per model. |
| `opencode-go` | `https://opencode.ai/zen/go/v1` | Same probe; some ids are chat-capable on Zen but served by an adapter on Go (e.g. `qwen3.8-max`), which error-driven routing discovers at call time. |
| `custom` | (you set `llm_base_url`) | `openai-chat`, or a v2 style with the matching path; `custom-path` for a path-only override. |

### opencode-zen and opencode-go

- **Key:** `Bearer` with your OpenCode API key, passed as the `llm_api_key` input (the `LLM_API_KEY` secret in the template).
- **Headers:** the action sends `User-Agent: pr-reviewer/1.0`. `opencode-go` also sends `x-opencode-session: pr-<number>`, stable per PR, so the provider can group the calls.
- **Model check:** the action reads the provider's model catalog, including native Google and Anthropic formats. The check is advisory: a definitive catalog miss skips the LLM path; an inconclusive check warns and continues to inference. It never changes the inference endpoint.
- **Routing:** with the default `auto` style, the action discovers the wire format at call time (error-driven routing): it sends the `openai-chat` request first and, on an HTTP 400 or 404 (wrong route or body contract), moves on to `openai-responses`, `anthropic-messages` and `google-models`. The style that works is remembered for the rest of the run. The same model can need different styles on different providers; nothing is hardcoded per model id. Set `llm_api_style` explicitly to skip the probe.
- **Go limits (operator reference):** a 5-hour window of 20%, a weekly limit of 50%, a monthly limit of 100%, and per-model caps of $15 to $60. When a Go subscription limit is hit, the provider falls back to the Zen balance. The action does not switch providers itself.

### API styles

| `llm_api_style` | Wire format | Used by |
|---|---|---|
| `auto` (default) | Error-driven probe: chat first, then the adapters below in order, learning the style from HTTP 400/404; the working style is remembered for the run. | Everything, automatically. |
| `openai-chat` | `POST {base}/chat/completions` | `openai`, `groq`, `mistral`, `openrouter`, `ollama`, `custom`; `anthropic` and `google` through their OpenAI-compatible layers; chat-capable Zen/Go models. |
| `openai-responses` | `POST {base}/responses` | Zen/Go `gpt-*`, `grok-*` and `muse-spark-*` models. Also native on the `openai` preset. |
| `anthropic-messages` | `POST {base}/messages` | Zen/Go `claude-*`, `qwen*` and `minimax*` models. Also native on the `anthropic` preset. |
| `google-models` | `POST {base}/models/<id>:generateContent` | Zen/Go `gemini-*` models. Also native on the `google` preset. |
| `custom-path` | Path-only override via `llm_path` (experimental). | Custom OpenAI-compatible endpoints. |

- Explicit `llm_api_style` values are functional: selecting `openai-responses`, `anthropic-messages` or `google-models` sends that protocol's body to `{base_url}` plus the style's default path (`llm_path` still overrides the path). An explicit style is honored as-is: exactly one request, no probing.
- `auto` is error-driven, with no model map: each attempt uses the style's full request shape, and only a 400 or 404 advances to the next style. Rate limits (429) and server errors (5xx) use the normal single retry and never advance the probe; a refusal, content filter or unparseable response is returned as-is. If every style is rejected, the slow path is skipped with a warning naming the model and the styles tried, plus the last HTTP error.
- The provider catalog check runs before the probe, including native Google and Anthropic catalogs. A definitive miss skips the LLM path; an inconclusive check warns and continues to inference. Probing never changes the catalog check.
- A path-only `llm_path` that names a non-chat endpoint (`/messages`, `/responses`, `/models`) is still rejected without a v2 style, because the path alone cannot select a body adapter.
- All styles share one outcome contract: the same findings schema, the same failure reasons, a 90 s timeout, one retry on 5xx/429, and `temperature`/`top_p` only when set explicitly.

## Agent mode

Set `llm_agent: true` and the reviewer gets read-only tools to inspect the repository before reporting, so it can verify claims (callers, definitions, configs, tests) instead of guessing from the diff alone. The tool loop is bounded by `llm_agent_max_turns` (default `10` tool-call rounds) and `llm_agent_max_seconds` (default `180` s wall-clock). Values under ~11 seconds leave no time for a model call (a 10 second reserve is held back) and abort immediately.

| Tool | What it does | Caps |
|---|---|---|
| `read_file` | Reads a UTF-8 text file with numbered lines (1-based, inclusive range). | Truncated with `[truncated]` past the 32768-byte per-result cap. |
| `list_dir` | Lists a directory shallowly (name, type, size), directories first then files. | First 200 entries; `truncated: true` when there are more. |
| `grep` | Searches file contents with a JavaScript regular expression. | At most 100 matches (`max_results` is capped at 100); files over 1 MiB are skipped. |
| `glob` | Lists repository-relative paths matching a glob pattern. | First 200 paths; `truncated: true` when there are more. |

At most 4 tool calls run per turn, each result is capped at 32768 bytes, and the loop stops when 131072 total result bytes are reached. Paths that escape the checkout, absolute paths, `..` segments and `.git` are rejected.

Linked repositories: `owner/repo` references (github.com URLs or bare `owner/repo` mentions) in the PR body, up to 3, are lazily cloned at the default branch (`--depth 1 --single-branch`) with `github_token` when a tool call names them. Only repositories mentioned in the PR body can be cloned; other aliases are refused. Parsing is logged as `agent linked repositories: ...`.

Fallback: a model whose endpoint rejects the tool-call shape (an HTTP 400 on the tool-call turn that succeeds without tools) is remembered as tools-unsupported and the run falls back to a single-shot review with the warning `agent tools unsupported for this model: using single-shot`.

Progress is logged per turn (`agent turn <n>: tools=[...] results_bytes=<b> ms=<ms>`) and at the end (`agent done: turns=<t> calls=<c> bytes=<b> stop=<stop> elapsed=<s>s`, with `stop=final` when the model returned the findings object).

In agent mode, whole files from the repository (and from linked repositories mentioned in the PR body) may be sent to your LLM provider — not just the diff.

## Cost

Budget figures are estimates. Prices change: check your provider's price page, and compare **Zen vs direto** (calling the model provider directly with its own key). Zen is pay-per-use through OpenCode, and its prices can differ from the direct provider prices.

- **Cost of a typical PR:** about 3k input tokens plus 600 output tokens.
- **Ceiling:** `max_prompt_chars` 120000 bytes is about 30k input tokens (≈bytes/4) plus prompt overhead. At frontier-model prices a PR at the ceiling costs roughly $0.30 to $0.60. Compare with the typical figure above (about 3k input and 600 output tokens). Lower `max_prompt_chars` to cap spend. `max_diff_chars` (60000 UTF-16 code units) stays the diff-only allowance inside that total. Files larger than the per-file cap (8000 characters) are truncated, and files over the total ceiling are skipped with a note. Any diff whose UTF-8 bytes exceed 120,000 skips the slow path at default config — e.g. ~40k units at 3 B/unit, ~60k units at 2 B/unit.
- **peak/off-peak pricing:** some models price by time of day. For example, `deepseek-v4.1-flash` has different peak and off-peak prices. Check the current rates before choosing a model for high-volume repositories.
- **Retries:** one retry after a fixed 500 ms delay, only on 5xx and 429. A `Retry-After` header replaces the delay, capped at 5 s. Timeouts and output truncation (`finish_reason: length`) are not retried with a smaller diff, because truncating the input does not fix truncated output.

## Gate: `fail_level`

Only PR-touched findings block. The review event and the exit code read the blocking set — findings on added lines, plus lineless findings on touched files — under the active level:

| `fail_level` | Review event | Exit code |
|---|---|---|
| `none` | always `COMMENT` | `0` always (log only) |
| `warning` | `COMMENT` | `2` if any blocking finding is `warning` or `high`; `0` for info-only |
| `high` | `REQUEST_CHANGES` when a blocking high-severity finding exists; otherwise `COMMENT` | `1` if any blocking high finding; `0` otherwise |

- The action never approves automatically in v1.
- A `REQUEST_CHANGES` review always has a body.
- The action step exits non-zero for `1` and `2`, so the template runs it with `continue-on-error: true` and reads `steps.review.outputs.exit-code` in a separate gate step.
- The template's gate passes on `0` and `2` and fails on `1`. Warning findings never block a merge. A failed run (for example an action error, where no exit code is produced) still fails the gate. To block on high-severity findings, set `fail_level: high`.
- A prompt-budget skip passes the gate on fast findings only; the skip is recorded in the step summary.
- Findings outside the PR diff never block on their own: they stay visible in the review body under `**Findings not placed inline:**`, preceded by a `**Note:** <n> finding(s) below are outside the PR diff and do not block.` header when at least one body item is non-blocking. Body items in the blocking set carry a `**blocking**` marker after the severity; folded excess inline comments outside the blocking set render `- path:line (non-blocking)`. Markers denote blocking-set membership read under the active fail level (a marked `warning` under `fail_level: high` still exits 0).
- **Wrongly-resolved findings re-block.** Clicking Resolve on a review thread while the flagged issue still persists re-arms the gate: the next run re-reads the PR's review threads and any of our own resolved threads whose finding is still reported blocks again, marked `**reopened**` (in the body, or inline when the line drifted to a commentable context line — never promoted, only marked). Matching is exact on file and line with rule intersection, so a re-merged thread still reopens its members. Identity is the token's own login, falling back to the newest `lupa:`-bodied review on installation tokens; when neither resolves, or the thread read fails, the run gates on diff membership only (fail-open, with a warning). Only the newest 100 threads are read (older ones warn-truncate).
- Only model-supplied replacement code renders in an applicable suggestion fence; explanatory text always renders as advice. A finding's `patch` fences inline as a GitHub `suggestion` on the new side, or renders as a plain advice-only replacement block elsewhere (the fallback report adds a `- Proposed patch (advice only):` row); `suggestion` never fences.

## Scanners and their runtimes

- **semgrep** runs from the PyPI package, pinned to `semgrep==1.180.0`. The unprivileged template installs it into a venv. No docker is needed for semgrep. Without `SEMGREP_APP_TOKEN` it runs `semgrep scan --config p/default --metrics=off` (`--config auto` is rejected when `--metrics=off` is set: "Cannot create auto config when metrics are off"); with a token it runs `semgrep ci` (diff-aware via `SEMGREP_BASELINE_COMMIT`).
- **gitleaks, trivy and osv-scanner** run from docker images pinned by digest. The runner needs docker for them. Without docker, each one reports a `scanner-missing` warning and the run continues.
- Docker scanners mount the checkout at `/src`, so SARIF reports absolute `/src/<path>` (or `file:///src/<path>`) artifact URIs. These are normalized back to repo-relative paths before findings are mapped, so inline comments still land on the right file.
- **Cross-scanner dedupe:** trivy and gitleaks can report the same secret or dependency once each. The single-shot LLM judges duplicates pairwise (`duplicates` index pairs, `duplicateOf` restatements) and deterministic code merges them: same file and line only, severity is the maximum, rules join with `+`, messages cite each rule. A wrong model pair never swallows an unrelated location — cross-file and cross-line verdicts are ignored with a warning. The gate sees the blocking subset of the merged set; the summary head/counts and the dry-run high count see the full pre-merge set; only the funnel (inline/body), SARIF, and marker counts use the merged set, while `findings.json` keeps the pre-merge set. When the slow path is skipped (no LLM) findings publish unmerged with a `lupa: dedup skipped` note; agent mode publishes unmerged with no note, by design.

## Finding provenance

Every finding may carry where it came from, what proves it, and how confident the claimant is:

- `source` names the producer (`semgrep`, `trivy`, `gitleaks`, `osv-scanner`, `gofmt`, `fastpath`, `sbom`, `l2`, `llm`). Absent means a legacy finding.
- `confidence` is an integer 0-100. Deterministic analyzer output reports confidence 90; heuristic text matches report confidence 50; the LLM reports its own 0-100 (absent when unmarked).
- `evidence` names the analyzer and carries the flagged snippet (the snippet is reserved in v1 and assigned by no producer).

Provenance is display-only: it never changes gates or severity. It renders as an inline `` `src:<source> · conf <n>` `` trailer, `- Source:` / `- Confidence:` / `- Evidence:` fallback rows, and SARIF `properties`.

Policy note: heuristic fastpath matches report confidence 50 even when they are high severity (for example sensitive-path findings), because emission requires added-line secret evidence — a path match alone never emits.

## Dry-run: `post_comment: false`

With `post_comment: false` the action runs the whole pipeline, writes the summary and the artifact, and logs the event from the blocking set and the finding counts it would have posted (event, inline, general, high and blocking). The review body is not logged. Nothing is posted to the PR. Use it to tune the prompt, the model, or `max_diff_chars` before you enable posting.

## Forks and the two-workflow setup

A fork PR gets a read-only `GITHUB_TOKEN`, so the review cannot be posted from the PR workflow. In that case the action writes the summary and uploads the review artifact (`pr-reviewer-out`, containing `diff.patch`, `pr-meta.json`, `findings.json`, `sarif.json` and `sbom.cdx.json`). Issue comments and code-scanning uploads do not work on read-only fork runs either.

To post reviews on fork PRs, use the two-workflow pattern:

1. **Unprivileged** (`docs/workflow-template.yml`, trigger `pull_request`): checks out the PR head with `persist-credentials: false`, writes the diff against the fetched base SHA, runs the review and uploads the artifact. It holds no App key.
2. **Privileged** (`docs/workflow-template-privileged.yml`, trigger `workflow_run` on `Lupa` with `types: [completed]`, guarded to fork `pull_request` runs that were not cancelled): runs in the base repository context. It only downloads the artifact by `run-id`, verifies the files, and posts the review, using the workflow-run token by default and upgrading to a GitHub App token created with `actions/create-github-app-token` when `PR_REVIEWER_APP_ID` is set. It never checks out PR code, never runs scanners or L2, and never calls the LLM.

On fork PRs, the workflow-run token is the default posting credential. An App token via `PR_REVIEWER_APP_ID` / `PR_REVIEWER_APP_KEY` is the recommended upgrade. Without an App token, the run posts with the workflow-run token and emits the downgrade notice. A `github-token` or unset token type never posts on a fork; it skips posting with a loud warning.

The segregation matters: the privileged job reads only the artifact, so PR code never runs with the App key.

**Why not `success` only:** the unprivileged job fails on purpose when `fail_level` gates a high-severity finding (exit `1`). The privileged job therefore accepts any conclusion except `cancelled`. Otherwise those high-severity reviews would never reach a fork PR. The artifact checks keep this safe: `pr-meta.json` is required, the PR is derived from the trusted `workflow_run` fields, and the head SHA, repository and branch must match the live PR. Same-repo runs are skipped there, because the unprivileged template already posts them.

**Fork L2 skip:** on fork PRs with secrets in scope (any trigger other than `pull_request`, an App token, or an `llm_api_key`), the action does not run L2 native toolchains, because they execute repository-defined tooling. Semgrep, gitleaks and trivy still run. The skip is logged as a warning and recorded as an info-level `l2-skipped` finding, which appears in the review body and the artifact.

**Known limitation:** every scanner and L2 process gets a scrubbed environment (no `*TOKEN*`, `*KEY*`, `*SECRET*`, `*PASSWORD*`, `*AUTH*`, `GITHUB_TOKEN` or `ACTIONS_*` variables). This is not a sandbox. A residual `/proc` vector remains: a process can read its parent's environment and memory maps. For high-threat repositories, move the review of untrusted code into a workflow with no secrets and no base-repository context, and post results only through the privileged template.

## Security notes

- Keep `permissions` minimal: `contents: read`, `pull-requests: write`. The unprivileged template ships `issues: write`, `security-events: write` and `actions: read` commented out; the privileged template already grants `actions: read` (needed for the `workflow_run` artifact fetch). Uncomment `issues: write` only with the issue-comment fallback (`PR_REVIEWER_ISSUE_FALLBACK: "true"`). Enabling the code-scanning SARIF upload needs **both** `security-events: write` and `actions: read` (private repos need `actions: read` for the workflow-run lookup, and the `upload-sarif` telemetry also uses it). With either one missing the upload fails with "Resource not accessible by integration" and `continue-on-error` silently absorbs it, so the review still posts.
- Pin the action and every third-party action to a commit SHA.
- Never interpolate PR titles or bodies into `run:` steps. `pull_request_target` is not used.
- `llm_api_key` is never written to logs. Prompt-injection defences are structural (delimited diff, no tools for the model, output validation, an auditable log of each call). They are not a guarantee.
- Artifact redaction is runtime-key masking only: `findings.json` and `sarif.json` mask the run's own `github_token` and `llm_api_key` values. Secrets committed in the diff are a separate scanner concern and are not covered.
- The model can be wrong. Treat findings as suggestions and keep human review for security-critical changes.

## Why the technical identifiers still say pr-reviewer

Lupa is the product's display name, but `pr-reviewer` remains the stable technical namespace: `PR_REVIEWER_*` variables and inputs, `pr-reviewer/1.0` user-agent, `pr-reviewer-*` concurrency groups, `pr-reviewer-out` artifacts and the SARIF driver name are all kept so existing workflows, gates and tooling keep working without migration. Human-readable messages use the `lupa:` prefix.
