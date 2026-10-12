import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
describe("scaffolding", () => {
  it("action.yml targets node24 dist and declares all consumed inputs", () => {
    const yml = fs.readFileSync("action.yml", "utf8");
    expect(yml).toContain("using: node24");
    expect(yml).toContain("main: dist/index.js");
    for (const s of ["github_token", "llm_provider", "llm_base_url", "llm_api_style", "llm_path", "llm_model", "llm_api_key", "llm_temperature", "llm_top_p", "pr_number", "fail_level", "max_diff_chars", "max_prompt_chars", "post_comment", "timeout_seconds", "llm_max_tokens", "llm_agent", "llm_agent_max_turns", "llm_agent_max_seconds"]) expect(yml).toContain(s);
  });
  it("package requires node24 and pins researched versions", () => {
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
    expect(pkg.engines.node).toMatch(/24/);
    expect(pkg.dependencies["@actions/core"]).toBe("3.0.1");
    expect(pkg.dependencies["@actions/github"]).toBe("9.1.1");
    expect(pkg.devDependencies["typescript"]).toBe("5.9.3");
    expect(pkg.devDependencies["vitest"]).toBe("5.0.3");
    expect(pkg.devDependencies["esbuild"]).toBe("0.28.2");
    const gi = fs.readFileSync(".gitignore", "utf8");
    expect(gi).not.toMatch(/^dist\/?$/m);
  });
  it("entry guard uses pathToFileURL, not a hand-built file:// URL", () => {
    const src = fs.readFileSync("src/main.ts", "utf8");
    expect(src).toContain("pathToFileURL");
    expect(src).not.toContain("`file://${");
  });
});
