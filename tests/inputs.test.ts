import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getInputs,
  parseFailLevel,
  LLM_PROVIDERS,
  LLM_API_STYLES,
} from "../src/inputs.js";

const INPUT_NAMES = [
  "github_token",
  "llm_provider",
  "llm_base_url",
  "llm_api_style",
  "llm_path",
  "llm_model",
  "llm_api_key",
  "llm_temperature",
  "llm_top_p",
  "pr_number",
  "fail_level",
  "max_diff_chars",
  "max_prompt_chars",
  "post_comment",
  "timeout_seconds",
  "llm_max_tokens",
  "llm_agent",
  "llm_agent_max_turns",
  "llm_agent_max_seconds",
  "max_findings",
  "max_inline_comments",
  "max_review_body_chars",
  "max_artifact_bytes",
];

let saved: Record<string, string | undefined> = {};

function setInputs(values: Record<string, string>): void {
  for (const name of INPUT_NAMES) {
    const key = `INPUT_${name.toUpperCase()}`;
    if (name in values) process.env[key] = values[name];
    else delete process.env[key];
  }
}

beforeEach(() => {
  saved = {};
  for (const name of INPUT_NAMES) {
    const key = `INPUT_${name.toUpperCase()}`;
    saved[key] = process.env[key];
  }
  setInputs({});
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("getInputs defaults", () => {
  it("defaults match spec", () => {
    const i = getInputs();
    expect(i.llmProvider).toBe("openai");
    expect(i.llmApiStyle).toBe("auto");
    expect(i.failLevel).toBe("warning");
    expect(i.maxDiffChars).toBe(60000);
    expect(i.maxPromptChars).toBe(120000);
    expect(i.timeoutSeconds).toBe(90);
    expect(i.llmMaxTokens).toBe(2000);
    expect(i.postComment).toBe(true);
    expect(i.llmTemperature).toBeUndefined();
    expect(i.llmTopP).toBeUndefined();
    expect(i.prNumber).toBeNull();
    expect(i.llmAgent).toBe(false);
    expect(i.llmAgentMaxTurns).toBe(10);
    expect(i.llmAgentMaxSeconds).toBe(180);
    expect(i.maxFindings).toBe(200);
    expect(i.maxInlineComments).toBe(30);
    expect(i.maxReviewBodyChars).toBe(60000);
    expect(i.maxArtifactBytes).toBe(8388608);
  });
});

describe("parseFailLevel", () => {
  it("accepts none|warning|high", () => {
    expect(parseFailLevel("none")).toBe("none");
    expect(parseFailLevel("warning")).toBe("warning");
    expect(parseFailLevel("high")).toBe("high");
  });

  it("rejects bad fail_level naming the input", () => {
    expect(() => parseFailLevel("block")).toThrow(/fail_level/);
  });
});

describe("getInputs fail_level / pr_number", () => {
  it("rejects bad fail_level via getInputs", () => {
    setInputs({ fail_level: "block" });
    expect(() => getInputs()).toThrow(/fail_level/);
  });

  it("parses pr_number when non-empty", () => {
    setInputs({ pr_number: "42" });
    expect(getInputs().prNumber).toBe(42);
  });

  it("rejects non-numeric pr_number", () => {
    setInputs({ pr_number: "abc" });
    expect(() => getInputs()).toThrow(/pr_number/);
  });

  it("rejects pr_number '0' (must be >= 1)", () => {
    setInputs({ pr_number: "0" });
    expect(() => getInputs()).toThrow(/pr_number/);
  });

  it("rejects pr_number '-1'", () => {
    setInputs({ pr_number: "-1" });
    expect(() => getInputs()).toThrow(/pr_number/);
  });

  it("rejects pr_number beyond MAX_SAFE_INTEGER", () => {
    setInputs({ pr_number: "9007199254740993" });
    expect(() => getInputs()).toThrow(/pr_number/);
  });

  it("accepts pr_number boundary '1' (minimum)", () => {
    setInputs({ pr_number: "1" });
    expect(getInputs().prNumber).toBe(1);
  });

  it("accepts pr_number boundary '9007199254740991' (MAX_SAFE_INTEGER)", () => {
    setInputs({ pr_number: "9007199254740991" });
    expect(getInputs().prNumber).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("getInputs enums (single source of truth)", () => {
  it("rejects unknown llm_provider naming the input", () => {
    setInputs({ llm_provider: "bogus" });
    expect(() => getInputs()).toThrow(/llm_provider/);
  });

  it("accepts every LLM_PROVIDERS value", () => {
    expect(LLM_PROVIDERS).toHaveLength(10);
    for (const p of LLM_PROVIDERS) {
      setInputs({ llm_provider: p });
      expect(getInputs().llmProvider).toBe(p);
    }
  });

  it("rejects unknown llm_api_style naming the input", () => {
    setInputs({ llm_api_style: "chat" });
    expect(() => getInputs()).toThrow(/llm_api_style/);
  });

  it("accepts every LLM_API_STYLES value", () => {
    expect(LLM_API_STYLES).toHaveLength(6);
    for (const s of LLM_API_STYLES) {
      setInputs({ llm_api_style: s });
      expect(getInputs().llmApiStyle).toBe(s);
    }
  });
});

describe("getInputs sampling (llm_temperature / llm_top_p)", () => {
  it("parses decimal values when non-empty", () => {
    setInputs({ llm_temperature: "0.5", llm_top_p: "0.9" });
    const i = getInputs();
    expect(i.llmTemperature).toBe(0.5);
    expect(i.llmTopP).toBe(0.9);
  });

  it("parses negative decimals (range is validateSampling's job)", () => {
    setInputs({ llm_temperature: "-0.5" });
    expect(getInputs().llmTemperature).toBe(-0.5);
  });

  it("leaves both undefined when inputs are empty strings", () => {
    setInputs({ llm_temperature: "", llm_top_p: "" });
    const i = getInputs();
    expect(i.llmTemperature).toBeUndefined();
    expect(i.llmTopP).toBeUndefined();
  });

  it("rejects non-numeric llm_temperature naming the input", () => {
    setInputs({ llm_temperature: "warm" });
    expect(() => getInputs()).toThrow(/llm_temperature/);
  });

  it("rejects non-numeric llm_top_p naming the input", () => {
    setInputs({ llm_top_p: "high" });
    expect(() => getInputs()).toThrow(/llm_top_p/);
  });

  it.each(["Infinity", "NaN", "0x10", "1e3", "1e-400"])(
    "rejects llm_temperature %s naming the input",
    (v) => {
      setInputs({ llm_temperature: v });
      expect(() => getInputs()).toThrow(/llm_temperature/);
    },
  );

  // Strict decimal form per spec grammar: leading-dot (.5) and explicit-plus (+0.5)
  // are not normalized inputs.
  it.each([".5", "+0.5"])("rejects llm_temperature %s by design (strict decimal form)", (v) => {
    setInputs({ llm_temperature: v });
    expect(() => getInputs()).toThrow(/llm_temperature/);
  });

  it.each([".5", "+0.5"])("rejects llm_top_p %s by design (strict decimal form)", (v) => {
    setInputs({ llm_top_p: v });
    expect(() => getInputs()).toThrow(/llm_top_p/);
  });

  it.each(["Infinity", "NaN", "0x10", "1e3"])("rejects llm_top_p %s naming the input", (v) => {
    setInputs({ llm_top_p: v });
    expect(() => getInputs()).toThrow(/llm_top_p/);
  });
});

describe("getInputs integer inputs", () => {
  it("coerces integer inputs", () => {
    setInputs({ max_diff_chars: "1000", timeout_seconds: "30", llm_max_tokens: "500" });
    const i = getInputs();
    expect(i.maxDiffChars).toBe(1000);
    expect(i.timeoutSeconds).toBe(30);
    expect(i.llmMaxTokens).toBe(500);
  });

  it("rejects non-integer max_diff_chars naming the input", () => {
    setInputs({ max_diff_chars: "12.5" });
    expect(() => getInputs()).toThrow(/max_diff_chars/);
  });

  it.each([
    ["timeout_seconds", "soon"],
    ["llm_max_tokens", "many"],
    ["max_diff_chars", "lots"],
  ])("rejects non-numeric %s naming the input", (name, v) => {
    setInputs({ [name]: v });
    expect(() => getInputs()).toThrow(new RegExp(name));
  });

  it.each([
    ["timeout_seconds", "0"],
    ["llm_max_tokens", "0"],
    ["max_diff_chars", "0"],
  ])("rejects %s = 0 (must be >= 1)", (name, v) => {
    setInputs({ [name]: v });
    expect(() => getInputs()).toThrow(new RegExp(name));
  });

  it.each([
    ["timeout_seconds", "9007199254740993"],
    ["llm_max_tokens", "9007199254740993"],
    ["max_diff_chars", "9007199254740993"],
    ["max_prompt_chars", "9007199254740993"],
  ])("rejects unsafe-integer %s naming the input", (name, v) => {
    setInputs({ [name]: v });
    expect(() => getInputs()).toThrow(new RegExp(name));
  });

  it("rejects non-integer max_prompt_chars naming the input", () => {
    setInputs({ max_prompt_chars: "12.5" });
    expect(() => getInputs()).toThrow(/max_prompt_chars/);
  });

  it.each([
    ["max_prompt_chars", "lots"],
    ["max_prompt_chars", "0"],
    ["max_prompt_chars", "-5"],
  ])("rejects max_prompt_chars %s naming the input", (name, v) => {
    setInputs({ [name]: v });
    expect(() => getInputs()).toThrow(new RegExp(name));
  });

  it("accepts max_prompt_chars boundary '1' (minimum)", () => {
    setInputs({ max_prompt_chars: "1" });
    expect(getInputs().maxPromptChars).toBe(1);
  });
});

describe("getInputs post_comment", () => {
  it("parses post_comment false", () => {
    setInputs({ post_comment: "false" });
    expect(getInputs().postComment).toBe(false);
  });

  it("rejects invalid post_comment naming the input", () => {
    setInputs({ post_comment: "yes" });
    expect(() => getInputs()).toThrow(/post_comment/);
  });
});

describe("getInputs agent inputs", () => {
  it("parses llm_agent, llm_agent_max_turns and llm_agent_max_seconds", () => {
    setInputs({ llm_agent: "true", llm_agent_max_turns: "3", llm_agent_max_seconds: "60" });
    const i = getInputs();
    expect(i.llmAgent).toBe(true);
    expect(i.llmAgentMaxTurns).toBe(3);
    expect(i.llmAgentMaxSeconds).toBe(60);
  });

  it("rejects llm_agent_max_turns = 0 (must be >= 1)", () => {
    setInputs({ llm_agent_max_turns: "0" });
    expect(() => getInputs()).toThrow(/llm_agent_max_turns/);
  });

  it("rejects llm_agent_max_seconds = 0 (must be >= 1)", () => {
    setInputs({ llm_agent_max_seconds: "0" });
    expect(() => getInputs()).toThrow(/llm_agent_max_seconds/);
  });

  it("rejects invalid llm_agent naming the input", () => {
    setInputs({ llm_agent: "yes" });
    expect(() => getInputs()).toThrow(/llm_agent/);
  });
});

describe("getInputs aggregate limits (F15)", () => {
  it("rejects max_findings = 0 (must be >= 1)", () => {
    setInputs({ max_findings: "0" });
    expect(() => getInputs()).toThrow(/max_findings/);
  });

  it.each(["5", "999"])("rejects max_review_body_chars %s (must be >= 1000)", (v) => {
    setInputs({ max_review_body_chars: v });
    expect(() => getInputs()).toThrow(/max_review_body_chars/);
  });

  it("accepts max_review_body_chars boundary '1000' (minimum)", () => {
    setInputs({ max_review_body_chars: "1000" });
    expect(getInputs().maxReviewBodyChars).toBe(1000);
  });

  it.each([
    ["max_findings", "12.5"],
    ["max_findings", "lots"],
    ["max_inline_comments", "12.5"],
    ["max_inline_comments", "lots"],
    ["max_review_body_chars", "12.5"],
    ["max_review_body_chars", "lots"],
    ["max_artifact_bytes", "12.5"],
    ["max_artifact_bytes", "lots"],
  ])("rejects %s %s naming the input", (name, v) => {
    setInputs({ [name]: v });
    expect(() => getInputs()).toThrow(new RegExp(name));
  });

  it.each([
    ["max_inline_comments", "0"],
    ["max_artifact_bytes", "0"],
  ])("rejects %s = 0 (must be >= 1)", (name, v) => {
    setInputs({ [name]: v });
    expect(() => getInputs()).toThrow(new RegExp(name));
  });
});
