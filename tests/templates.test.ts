import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("workflow templates", () => {
  it.each([["0", 0], ["2", 0], ["1", 1], ["3", 1], ["", 1], ["garbage", 1]] as const)(
    "executes the actual gate shell for output %j (exit %i)", (exitCode, expectedExit) => {
      const template = fs.readFileSync("docs/workflow-template.yml", "utf8");
      const block = template.slice(template.indexOf("      - name: Enforce fail_level"));
      const script = block.slice(block.indexOf("        run: |\n") + "        run: |\n".length)
        .split("\n").map(line => line.replace(/^ {10}/, "")).join("\n");
      const result = spawnSync("bash", ["-euo", "pipefail", "-c", script], { env: { ...process.env, EXIT_CODE: exitCode }, encoding: "utf8" });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(expectedExit);
      if (expectedExit === 1) expect(result.stderr).toContain(`gate failed (exit code: ${exitCode || "none"})`);
    },
  );

  it("makes advisory setup explicit in both trusted action inputs", () => {
    for (const file of ["docs/workflow-template.yml", "docs/workflow-template-privileged.yml"]) {
      const text = fs.readFileSync(file, "utf8");
      const inputBlock = text.slice(text.indexOf("uses: cpenaforte/lupa@"));
      expect(inputBlock).toMatch(/^ {10}analysis_policy: advisory$/m);
    }
  });
  it("uploads analysis.json with the review artifact on unsuccessful analysis runs", () => {
    const text = fs.readFileSync("docs/workflow-template.yml", "utf8");
    const upload = text.split(/^      - name: /m).find(step => step.startsWith("Upload review artifact\n"))!;
    expect(upload).toMatch(/^        if: always\(\)$/m);
    expect(upload).toMatch(/^        uses: actions\/upload-artifact@[0-9a-f]{40}/m);
    expect(upload).toMatch(/^          name: pr-reviewer-out$/m);
    const paths = upload.split("          path: |\n")[1]!.trim().split("\n").map(line => line.trim());
    expect(paths).toEqual([
      "${{ runner.temp }}/pr-reviewer-out/diff.patch",
      "${{ runner.temp }}/pr-reviewer-out/pr-meta.json",
      "${{ runner.temp }}/pr-reviewer-out/findings.json",
      "${{ runner.temp }}/pr-reviewer-out/analysis.json",
      "${{ runner.temp }}/pr-reviewer-out/sarif.json",
      "${{ runner.temp }}/pr-reviewer-out/sbom.cdx.json",
    ]);
  });
  it("consumer jobs have a 30 minute wall-clock backstop", () => {
    for (const file of ["docs/workflow-template.yml", "docs/workflow-template-privileged.yml"]) {
      const text = fs.readFileSync(file, "utf8");
      const jobs = text.split(/^  [a-zA-Z][\w-]*:\s*$/m).slice(1);
      expect(jobs.length).toBeGreaterThan(0);
      for (const job of jobs.filter((entry) => /^    runs-on:/m.test(entry))) {
        expect(job.match(/^    timeout-minutes: (\d+)$/m)?.[1]).toBe("30");
      }
    }
  });
  it("passes only the trusted Actions actor variable, empty when unset", () => {
    for (const file of ["docs/workflow-template.yml", "docs/workflow-template-privileged.yml"]) {
      const text = fs.readFileSync(file, "utf8");
      expect(text.match(/^\s+review_actor: (.+)$/gm)?.map((line) => line.trim())).toEqual(["review_actor: ${{ vars.PR_REVIEWER_ACTOR }}"]);
    }
  });
  it("both templates pin the v0.13.0 release SHA", () => {
    for (const file of [
      "docs/workflow-template.yml",
      "docs/workflow-template-privileged.yml",
    ]) {
      expect(fs.readFileSync(file, "utf8")).toContain(
        "uses: cpenaforte/lupa@cbc17a39b53d2d921d33ac784084145b34ed7126",
      );
    }
  });

  it("templates pin SHA, least privilege, guards, concurrency", () => {
    const t = fs.readFileSync("docs/workflow-template.yml", "utf8");
    expect(t).toContain("fetch-depth: 0");
    expect(t).toContain("persist-credentials: false");
    expect(t).toContain("pull/");
    expect(t).toContain("/head");
    expect(t).toContain("fetch");
    expect(t).toContain("git diff -U3");
    expect(t).toContain("base_sha");
    expect(t).not.toMatch(/run:\s*.*\bgit diff[^\\n]*\bHEAD(?!_SHA)\b/);
    expect(t).toContain("cancel-in-progress: true");
    expect(t).toContain("continue-on-error: true");
    expect(t).toContain("github.event.pull_request.number || github.event.issue.number || inputs.pr_number");
    expect(t).toContain("upload-artifact");
    expect(t).toContain("diff.patch");
    expect(t).toContain("pr-meta.json");
    expect(t).toContain("findings.json");
    expect(t).toContain("types: [created]");
    expect(t).toContain("types: [submitted]");
    expect(t).toContain("github.event.issue.pull_request");
    expect(t).toContain("opened");
    expect(t).toContain("synchronize");
    expect(t).toContain("reopened");
    expect(t).toContain("ready_for_review");
    expect(t).toContain("contents: read");
    expect(t).toContain("pull-requests: write");
    expect(t).not.toMatch(/checks:\s*write/);
    expect(t).toMatch(/issues:\s*write[\s\S]{0,200}fallback|fallback[\s\S]{0,200}issues:\s*write/);
    const p = fs.readFileSync("docs/workflow-template-privileged.yml", "utf8");
    expect(p).toContain("workflow_run");
    expect(p).toContain("types: [completed]");
    expect(p).toContain("conclusion != 'cancelled'");
    expect(p).not.toContain("conclusion == 'success'");
    expect(p).toContain("github.event.workflow_run.head_repository.full_name != github.repository");
    expect(p).toContain("github.event.workflow_run.event == 'pull_request'");
    expect(p).toContain("pr-reviewer-priv-");
    expect(p).toContain("head_repository.full_name");
    expect(p).toContain("head_branch");
    expect(p).not.toMatch(/pull_requests\[0\]/);
    expect(p).toContain("contents: read");
    expect(p).toContain("pull-requests: write");
    expect(p).toContain("actions: read");
    expect(p).toContain("create-github-app-token@");
    expect(p).toMatch(/uses:\s*\S+@[0-9a-f]{40}/);
    expect(t).toMatch(/uses:\s*\S+@[0-9a-f]{40}/);
    expect(t).not.toMatch(/uses:\s*[^#\n]+@(v\d|main|master|latest)/);
    expect(p).not.toMatch(/uses:\s*[^#\n]+@(v\d|main|master|latest)/);
    expect(t).not.toMatch(/github\.event\.pull_request\.title|github\.event\.pull_request\.body/);
    expect(p).toContain("download-artifact");
    expect(p).toContain("diff.patch");
    expect(p).toContain("pr-meta.json");
    expect(p).toContain("findings.json");
    expect(p).not.toContain("upload-artifact");
    expect(t).not.toMatch(/pull_request_target/);
    expect(p).not.toMatch(/pull_request_target/);
    expect(p).toContain("run-id:");
    expect(p).toContain("runner.temp");
    expect(p).not.toMatch(/^\s*-\s*uses:\s*actions\/checkout\b/m);
    expect(p).not.toMatch(/run:\s*.*\b(checkout|semgrep|trivy|osv-scanner|ollama pull|chat\/completions)\b/m);
  });

  it("privileged guards: fork-only (no double post) and not-cancelled (high-severity reviews still post)", () => {
    const p = fs.readFileSync("docs/workflow-template-privileged.yml", "utf8");
    const ifLine = p.slice(p.indexOf("    if: >-"), p.indexOf("    runs-on:", p.indexOf("    if: >-")));
    expect(ifLine).toContain("conclusion != 'cancelled'");
    expect(ifLine).toContain("github.event.workflow_run.event == 'pull_request'");
    expect(ifLine).toContain("head_repository.full_name != github.repository");
    expect(p).toMatch(/Why the guards look like this/);
  });

  it("unprivileged job gates re-trigger comments and reviews on trusted author associations", () => {
    const t = fs.readFileSync("docs/workflow-template.yml", "utf8");
    expect(t).toContain('contains(fromJSON(\'["OWNER","MEMBER","COLLABORATOR"]\'), github.event.comment.author_association)');
    expect(t).toContain('contains(fromJSON(\'["OWNER","MEMBER","COLLABORATOR"]\'), github.event.review.author_association)');
  });

  it("privileged template has NO SARIF upload (fork tokens lack security-events: write); comment says so", () => {
    const p = fs.readFileSync("docs/workflow-template-privileged.yml", "utf8");
    expect(p).not.toContain("upload-sarif");
    expect(p).not.toContain("codeql-action");
    expect(p).toContain("SARIF: this privileged flow never uploads SARIF");
    expect(p).toContain("Code-scanning uploads happen only in the same-repo");
  });

  it("semgrep is installed from PyPI at the pinned version (no docker)", () => {
    const t = fs.readFileSync("docs/workflow-template.yml", "utf8");
    expect(t).toContain("semgrep==1.180.0");
    expect(t).toContain("python3 -m venv");
    expect(t).toContain('echo "$RUNNER_TEMP/lupa-semgrep-venv/bin" >> "$GITHUB_PATH"');
  });

  it("semgrep setup runs with cwd outside the PR checkout", () => {
    const t = fs.readFileSync("docs/workflow-template.yml", "utf8");
    expect(t).toContain("working-directory: ${{ runner.temp }}");
    expect(t).toContain("$RUNNER_TEMP/lupa-semgrep-venv");
    expect(t).not.toContain("$RUNNER_TEMP/semgrep-venv");
  });

  it("explicit fetches authenticate in memory via GIT_CONFIG env, anonymous otherwise", () => {
    const t = fs.readFileSync("docs/workflow-template.yml", "utf8");
    expect(t).toContain("http.extraheader");
    expect(t).toContain("GIT_CONFIG_KEY_0=http.extraheader");
    expect(t).toContain("AUTHORIZATION: basic");
    expect(t).toContain("x-access-token");
    expect(t).toContain('if [ -n "${FETCH_TOKEN:-}" ]');
    expect(t).toMatch(/Without a token the fetch is anonymous/);
    expect(t).not.toMatch(/-c\s+http\.extraheader/);
    expect(t).toContain("persist-credentials: false");
  });

  it("diff uses core.quotePath=false", () => {
    const t = fs.readFileSync("docs/workflow-template.yml", "utf8");
    expect(t).toContain("GIT_CONFIG_PARAMETERS=\"'core.quotePath=false'\"");
    expect(t).toContain("git diff -U3");
  });

  it("issues: write is commented out by default, with the fallback explanation", () => {
    const t = fs.readFileSync("docs/workflow-template.yml", "utf8");
    expect(t).toMatch(/^\s*#\s*issues:\s*write/m);
    expect(t).not.toMatch(/^ {2}issues:\s*write/m);
    expect(t).not.toMatch(/^ {2}security-events:\s*write/m);
  });

  it("explicit fetches use portable base64 (no GNU-only -w0)", () => {
    const t = fs.readFileSync("docs/workflow-template.yml", "utf8");
    expect(t).not.toContain("-w0");
    expect(t).toContain("base64 | tr -d '\\n'");
  });

  it("every step name is valid as a plain YAML scalar or is quoted (colon-safe)", () => {
    for (const file of ["docs/workflow-template.yml", "docs/workflow-template-privileged.yml"]) {
      const text = fs.readFileSync(file, "utf8");
      for (const line of text.split("\n")) {
        const m = /^\s*(?:- )?name:\s*(.+)$/.exec(line);
        if (!m) continue;
        const v = m[1].trim();
        if (v.startsWith('"') || v.startsWith("'")) continue;
        expect(v, `${file}: ${line}`).not.toMatch(/:\s/);
        expect(v, `${file}: ${line}`).not.toMatch(/\s#/);
      }
    }
  });

  it("the SARIF step name is quoted (the colon in its name broke the YAML before)", () => {
    const t = fs.readFileSync("docs/workflow-template.yml", "utf8");
    expect(t).toContain('- name: "Upload SARIF (same-repo PRs; needs security-events: write + actions: read above)"');
  });

  it("moves concurrency to the review job and gates non-review comments", () => {
    const t = fs.readFileSync("docs/workflow-template.yml", "utf8");
    expect(t.slice(0, t.indexOf("jobs:"))).not.toContain("concurrency:");
    const job = t.slice(t.indexOf("  review:"));
    expect(job).toContain("concurrency:");
    expect(job).toContain("cancel-in-progress: true");
    expect(t).toContain("contains(github.event.comment.body, '/review')");
    expect(t).toContain("github.event.review.body != ''");
  });

  it("SARIF enablement documents that BOTH permissions are required and the failure mode", () => {
    const t = fs.readFileSync("docs/workflow-template.yml", "utf8");
    // Both lines stay commented by default (least privilege).
    expect(t).toMatch(/^ {2}# security-events: write$/m);
    expect(t).toMatch(/^ {2}# actions: read$/m);
    expect(t).not.toMatch(/^ {2}security-events: write$/m);
    expect(t).not.toMatch(/^ {2}actions: read$/m);
    // The permissions comment names both and says why private repos need actions: read.
    const perms = t.slice(t.indexOf("permissions:"), t.indexOf("jobs:"));
    expect(perms).toContain("security-events: write");
    expect(perms).toContain("actions: read");
    expect(perms).toContain("Resource not accessible by integration");
    expect(perms).toMatch(/private repo/i);
  });

  it("the SARIF step comment names both required permissions", () => {
    const t = fs.readFileSync("docs/workflow-template.yml", "utf8");
    const comment = t.slice(t.indexOf("# This step is evaluated on every event"), t.indexOf('- name: "Upload SARIF'));
    expect(comment).toContain("security-events: write");
    expect(comment).toContain("actions: read");
  });

  it("trust model comment states the precise claim and the /proc-vector limitation", () => {
    const t = fs.readFileSync("docs/workflow-template.yml", "utf8");
    expect(t).toContain("L2 native toolchains");
    expect(t).toContain("/proc-vector");
    expect(t).toContain("separate the review of untrusted code");
    expect(t).toContain("This is NOT a sandbox");
  });

  it("SARIF comments state the no-op condition and the skipped events", () => {
    const t = fs.readFileSync("docs/workflow-template.yml", "utf8");
    expect(t).toContain("issue_comment and workflow_dispatch");
    expect(t).toMatch(/This step is evaluated on every event/);
    expect(t).toContain("issue_comment and workflow_dispatch");
    expect(t).toContain("continue-on-error absorbs it");
  });

  it("vitest config excludes compiled lib/ and the dist/ bundle from collection", () => {
    const cfg = fs.readFileSync("vitest.config.ts", "utf8");
    expect(cfg).toContain('"lib/**"');
    expect(cfg).toContain("configDefaults");
    expect(cfg).toContain('"dist/**"');
    expect(cfg).toContain("exclude:");
    expect(cfg).toContain("include:");
  });

  it("unprivileged template uploads SARIF behind same-repo and permission guards", () => {
    const t = fs.readFileSync("docs/workflow-template.yml", "utf8");
    expect(t).toMatch(/upload-sarif@[0-9a-f]{40}/);
    expect(t).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(t).toContain("sarif_file:");
    expect(t).toContain("sarif.json");
    expect(t).toMatch(/#\s*security-events:\s*write/);
    expect(t).not.toContain("SEMGREP_APP_TOKEN");
    const p = fs.readFileSync("docs/workflow-template-privileged.yml", "utf8");
    expect(p).not.toContain("upload-sarif");
    expect(p).not.toMatch(/^ {2}issues:\s*write/m);
  });

  it("privileged template falls back to the workflow-run token with a visible downgrade notice", () => {
    const p = fs.readFileSync("docs/workflow-template-privileged.yml", "utf8");
    const sentence =
      "lupa: posting fork review with the workflow-run token (App token unavailable). For App-token posting set PR_REVIEWER_APP_ID / PR_REVIEWER_APP_KEY — see README (fork reviews)";
    const escaped = sentence.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Guard step present with the exact name.
    expect(p).toContain("- name: Note posting credential");
    // Guard condition pins always() plus the App-outcome check.
    const guardIdx = p.indexOf("Note posting credential");
    const guardEnd = p.indexOf("- name:", guardIdx + 1);
    const guardBlock = p.slice(guardIdx, guardEnd);
    expect(guardBlock).toContain("always()");
    expect(guardBlock).toContain("steps.app.outcome != 'success'");
    // Summary emission is a heredoc carrying the bare sentence on its own line
    // (leading YAML indent allowed; an echo-prefix or trailing text fails).
    expect(guardBlock).toContain('cat >> "$GITHUB_STEP_SUMMARY" <<\'EOF\'');
    expect(guardBlock).toMatch(new RegExp(`^[ \\t]*${escaped}$`, "m"));
    expect(guardBlock).toMatch(/^[ \t]*EOF$/m);
    // Annotation echoes the identical line with the ::notice:: prefix.
    expect(guardBlock).toContain("::notice::" + sentence);
    expect(guardBlock).toContain(`echo "::notice::${sentence}"`);
    // Ordering: guard sits after the App step and before the download step.
    const appIdx = p.indexOf("Create GitHub App token");
    const downloadIdx = p.indexOf("Download the PR run's review artifact");
    expect(appIdx).toBeGreaterThanOrEqual(0);
    expect(downloadIdx).toBeGreaterThanOrEqual(0);
    expect(guardIdx).toBeGreaterThan(appIdx);
    expect(guardIdx).toBeLessThan(downloadIdx);
    // The App step's own block carries continue-on-error (scoped, not file-wide).
    const appBlock = p.slice(appIdx, p.indexOf("- name:", appIdx + 1));
    expect(appBlock).toContain("continue-on-error: true");
    // Token-type fallback arm uses the workflow-run token.
    expect(p).toContain("'workflow-run'");
    expect(p).toContain("steps.app.outcome == 'success' && 'app'");
  });

  it("unprivileged template warns visibly when the optional SARIF upload fails", () => {
    const t = fs.readFileSync("docs/workflow-template.yml", "utf8");
    const sentence =
      "lupa: SARIF upload failed — code-scanning results were not uploaded. See the Upload SARIF step log for the cause (commonly: grant security-events: write / actions: read in workflow permissions), or ignore if code scanning is not used.";
    const escaped = sentence.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    /** Step keys only (6-space `- key:` or 8-space `key:`), excluding the indented run body. */
    const stepKeys = (block: string): string[] =>
      block
        .split("\n")
        .map((l) => /^(?: {6}- | {8}|- )([a-z-]+):/.exec(l)?.[1])
        .filter((k): k is string => k !== undefined);

    // The upload step gains exactly one line (`id: sarif`); every other key is unchanged.
    const uploadIdx = t.indexOf('- name: "Upload SARIF');
    expect(uploadIdx).toBeGreaterThanOrEqual(0);
    const uploadEnd = t.indexOf("- name:", uploadIdx + 1);
    const uploadBlock = t.slice(uploadIdx, uploadEnd);
    expect(stepKeys(uploadBlock)).toEqual(["name", "id", "if", "continue-on-error", "uses", "with"]);

    // The note step sits immediately after the upload step (nothing else moves).
    const noteIdx = t.indexOf('- name: "Note SARIF upload failure"');
    expect(noteIdx).toBeGreaterThanOrEqual(0);
    expect(t.slice(uploadEnd, uploadEnd + 40)).toContain("Note SARIF upload failure");
    const noteEnd = t.indexOf("- name:", noteIdx + 1);
    const noteBlock = t.slice(noteIdx, noteEnd);
    expect(stepKeys(noteBlock)).toEqual(["name", "if", "run"]);

    // Guard pins always() plus `== 'failure'`: a failed upload warns, while a skipped step
    // (fork, issue_comment, workflow_dispatch, or the same-repo guard false) has outcome
    // 'skipped' — `!= 'success'` would warn on those too, so the vocabulary is load-bearing.
    expect(noteBlock).toContain("always()");
    expect(noteBlock).toContain("steps.sarif.outcome == 'failure'");
    expect(noteBlock).not.toContain("!= 'success'");

    // Annotation echoes the sentence with the ::warning:: prefix.
    expect(noteBlock).toContain(`echo "::warning::${sentence}"`);

    // Summary emission is a heredoc carrying the bare sentence on its own line
    // (leading YAML indent allowed; an echo-prefix or trailing text fails).
    expect(noteBlock).toContain('cat >> "$GITHUB_STEP_SUMMARY" <<\'EOF\'');
    expect(noteBlock).toMatch(new RegExp(`^[ \\t]*${escaped}$`, "m"));
    expect(noteBlock).toMatch(/^[ \t]*EOF$/m);

    // Echoes only: the note step never fails the job (no continue-on-error, exit or false).
    expect(noteBlock).not.toContain("continue-on-error");
    expect(noteBlock).not.toMatch(/\bexit\b/);
    expect(noteBlock).not.toMatch(/\bfalse\b/);
  });

  it("both templates pin the same fail_level (severity parity)", () => {
    const extract = (file: string): string => {
      const text = fs.readFileSync(file, "utf8");
      const usesIdx = text.indexOf("uses: cpenaforte/lupa@");
      expect(usesIdx, `${file}: lupa step missing`).toBeGreaterThanOrEqual(0);
      const withIdx = text.indexOf("with:", usesIdx);
      expect(withIdx, `${file}: with block missing`).toBeGreaterThanOrEqual(0);
      const block = text.slice(withIdx, withIdx + 1500);
      const m = /fail_level: (\w+)/.exec(block);
      expect(m, `${file}: fail_level missing from lupa with block`).not.toBeNull();
      const level = m![1];
      expect(["none", "warning", "high"]).toContain(level);
      return level;
    };
    const privileged = extract("docs/workflow-template-privileged.yml");
    const producer = extract("docs/workflow-template.yml");
    expect(privileged).toBe(producer);
  });
});

describe("minimal workflow template", () => {
  const FILE = "docs/workflow-template-minimal.yml";
  const text = () => fs.readFileSync(FILE, "utf8");

  it("pins lupa to the same release SHA as the full templates", () => {
    const pin = /uses: (cpenaforte\/lupa@[0-9a-f]{40})/.exec(fs.readFileSync("docs/workflow-template.yml", "utf8"))![1];
    expect(text()).toContain(`uses: ${pin}`);
  });

  it("pins every third-party action by commit SHA and has no mutable refs", () => {
    const uses = text().match(/^\s+uses:\s*\S+/gm) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(2);
    for (const u of uses) expect(u).toMatch(/@[0-9a-f]{40}$/);
    expect(text()).not.toContain("pull_request_target");
  });

  it("is least privilege and supplies what the action requires", () => {
    const t = text();
    expect(t).toMatch(/permissions:\n {2}contents: read\n {2}pull-requests: write\n/);
    for (const needle of [
      "persist-credentials: false",
      "fetch-depth: 0",
      "PR_REVIEWER_BASE_SHA: ${{ github.event.pull_request.base.sha }}",
      "PR_REVIEWER_HEAD_SHA: ${{ github.event.pull_request.head.sha }}",
      "PR_REVIEWER_ARTIFACT_DIR: ${{ runner.temp }}/pr-reviewer-out",
      "/pr-reviewer-out/diff.patch",
      "llm_api_key: ${{ secrets.LLM_API_KEY }}",
      "review_actor: github-actions[bot]",
      "llm_model: ${{ vars.PR_REVIEWER_MODEL }}",
      "continue-on-error: true",
      "semgrep==1.180.0",
    ]) expect(t).toContain(needle);
    expect(t).not.toMatch(/run:\s*.*\bgit diff[^\n]*\bHEAD(?!_SHA)\b/);
  });

  it.each([["0", 0], ["2", 0], ["1", 1], ["3", 1], ["", 1], ["garbage", 1]] as const)(
    "executes the actual gate shell for output %j (exit %i)", (exitCode, expectedExit) => {
      const block = text().slice(text().indexOf("      - name: Gate"));
      const script = block.slice(block.indexOf("        run: |\n") + "        run: |\n".length)
        .split("\n").map((line) => line.replace(/^ {10}/, "")).join("\n");
      const result = spawnSync("bash", ["-euo", "pipefail", "-c", script], { env: { ...process.env, EXIT_CODE: exitCode }, encoding: "utf8" });
      expect(result.status).toBe(expectedExit);
    });
});
