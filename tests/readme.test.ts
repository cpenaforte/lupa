import * as fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("README", () => {
  it("readme covers providers costs fork dry-run and levels", () => {
    const r = fs.readFileSync("README.md", "utf8");
    for (const s of [
      "opencode-zen",
      "opencode-go",
      "workflow_run",
      "post_comment",
      "fail_level",
      "typical",
      "peak/off-peak",
      "Zen vs direto",
      "v1",
      "v2",
      "fork",
      "App",
      "two-workflow",
      "artifact",
      "dry-run",
      "REQUEST_CHANGES",
      "lupa",
    ]) {
      expect(r).toContain(s);
    }
  });

  it("readme states the phrases that pin behavior", () => {
    const r = fs.readFileSync("README.md", "utf8");
    for (const s of [
      "two-workflow pattern",
      "Dry-run: `post_comment: false`",
      "fail_level: high",
      "when a high-severity finding exists",
      "Warning findings never block a merge",
      "event, inline, general and high",
      "llm_provider: opencode-go",
      "Anthropic-compatible",
    ]) {
      expect(r).toContain(s);
    }
    // R8: the sampling note must sit in the Anthropic-compatible paragraph.
    const note = r.slice(r.indexOf("Anthropic-compatible presets"), r.indexOf("Anthropic-compatible presets") + 600);
    expect(note).toContain("temperature");
    expect(note).toContain("top_p");
    expect(note).toContain("family");
    expect(note).toContain("validated per model family (for example, `n` must be 1, and `temperature` and `top_p` cannot be set together)");
    expect(r).toContain("Compare with the typical figure above (about 3k input and 600 output tokens)");
    expect(r).not.toContain("has evidence");
    expect(r).not.toContain("writable App token");
    expect(r).not.toContain("OPENCODE_API_KEY");
  });

  it("readme documents the exit-code gate and the fork L2 skip", () => {
    const r = fs.readFileSync("README.md", "utf8");
    expect(r).toContain("exit-code");
    expect(r).toContain("/proc");
    expect(r).toContain("LLM_API_KEY");
    expect(r).toContain("docs/workflow-template.yml");
    expect(r).toContain("docs/workflow-template-privileged.yml");
  });

  it("readme documents SARIF enablement needing both security-events: write and actions: read", () => {
    const r = fs.readFileSync("README.md", "utf8");
    const sec = r.slice(r.indexOf("## Security notes"), r.indexOf("## Why the technical identifiers"));
    expect(sec).toContain("security-events: write");
    expect(sec).toContain("actions: read");
    expect(sec).toContain("continue-on-error");
    expect(sec).toMatch(/review still posts/i);
  });

  it("documents the agent inputs, tools and disclosure", () => {
    const r = fs.readFileSync("README.md", "utf8");
    for (const s of [
      "llm_agent",
      "llm_agent_max_turns",
      "llm_agent_max_seconds",
      "max_findings",
      "max_inline_comments",
      "max_review_body_chars",
      "max_artifact_bytes",
      "read_file",
      "stop=final",
    ]) {
      expect(r).toContain(s);
    }
    expect(r).toContain(
      "In agent mode, whole files from the repository (and from linked repositories mentioned in the PR body) may be sent to your LLM provider — not just the diff.",
    );
  });

  it("documents runtime-key masking scope", () => {
    const r = fs.readFileSync("README.md", "utf8");
    expect(r).toContain("runtime-key masking only");
    expect(r).toContain("separate scanner concern");
  });

  it("fork section documents the workflow-run credential chain", () => {
    const r = fs.readFileSync("README.md", "utf8");
    expect(r).toContain("two-workflow pattern");
    expect(r).toContain(
      "On fork PRs, the workflow-run token is the default posting credential.",
    );
    expect(r).toContain(
      "An App token via `PR_REVIEWER_APP_ID` / `PR_REVIEWER_APP_KEY` is the recommended upgrade.",
    );
    expect(r).toContain(
      "Without an App token, the run posts with the workflow-run token and emits the downgrade notice.",
    );
    expect(r).toContain(
      "A `github-token` or unset token type never posts on a fork; it skips posting with a loud warning.",
    );
  });
});

describe("README finding provenance (Q04)", () => {
  it("documents the provenance section: fields, values, display-only gates, conf-50-on-high policy", () => {
    const r = fs.readFileSync("README.md", "utf8");
    expect(r).toContain("## Finding provenance");
    expect(r).toContain("`source` names the producer");
    expect(r).toContain("`confidence` is an integer 0-100");
    expect(r).toContain("`evidence` names the analyzer");
    expect(r).toContain(
      "Deterministic analyzer output reports confidence 90; heuristic text matches report confidence 50; the LLM reports its own 0-100 (absent when unmarked).",
    );
    expect(r).toContain("Provenance is display-only: it never changes gates or severity.");
    expect(r).toContain(
      "Policy note: heuristic fastpath matches report confidence 50 even when they are high severity",
    );
  });
});
