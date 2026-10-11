import * as fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("workflow templates", () => {
  it("both templates pin the v0.5.0 release SHA", () => {
    for (const file of [
      "docs/workflow-template.yml",
      "docs/workflow-template-privileged.yml",
    ]) {
      expect(fs.readFileSync(file, "utf8")).toContain(
        "uses: cpenaforte/lupa@658ab55ae32d6e9e53193a5d6be75c3794de71d8",
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
});
