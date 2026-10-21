import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeTool, validateToolArgs, TOOL_DEFS, type ToolContext } from "../src/agent-tools.js";
import { runAgent } from "../src/agent.js";
import { callChatTurn } from "../src/llm.js";
import { callResponsesTurn } from "../src/adapters/responses.js";
import { callMessagesTurn } from "../src/adapters/messages.js";
import { callGoogleTurn } from "../src/adapters/google.js";
import type { ResolvedEndpoint } from "../src/providers.js";
import type { Conversation } from "../src/agent-types.js";

const created: string[] = [];
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "lupa-tool-args-"));
  created.push(dir);
  writeFileSync(join(dir, "a.txt"), "hello\n");
  return dir;
}
afterEach(() => {
  vi.unstubAllGlobals();
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

describe("tool argument validation before repository access", () => {
  const invalid: Array<[string, unknown]> = [
    ...["read_file", "list_dir", "grep", "glob"].flatMap((name) =>
      [undefined, null, [], "bad", 42, true].map((args): [string, unknown] => [name, args])),
    ["read_file", {}], ["read_file", { path: 3 }],
    ["read_file", { path: "a.txt", start: "1" }], ["read_file", { path: "a.txt", end: null }],
    ["list_dir", { path: 3 }], ["list_dir", { repo: null }],
    ["grep", {}], ["grep", { pattern: null }], ["grep", { pattern: 3 }],
    ["grep", { pattern: "hello", path: false }], ["grep", { pattern: "hello", glob: [] }],
    ["grep", { pattern: "hello", max_results: "1" }],
    ["glob", {}], ["glob", { pattern: [] }],
    ...["read_file", "list_dir", "grep", "glob"].map((name): [string, unknown] =>
      [name, { path: "a.txt", pattern: "hello", repo: 5 }]),
    ["read_file", { repo: "linked" }], ["grep", { repo: "linked" }], ["glob", { repo: "linked" }],
  ];
  it.each(invalid)("rejects %s %j without resolving roots or linked repositories", async (name, args) => {
    let accesses = 0;
    const ctx: ToolContext = {
      roots: { get self(): string { accesses++; throw new Error("repository access"); } },
      ensureLinked: async () => { accesses++; return { error: "repository access" }; },
    };
    const result = await executeTool(name, args, ctx);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.output).error).toMatch(/invalid.*argument/i);
    expect(accesses).toBe(0);
  });

  it("supports an explicit empty grep pattern and the list_dir root default", async () => {
    const ctx = { roots: { self: root() } };
    const grep = await executeTool("grep", { pattern: "" }, ctx);
    expect(grep.isError).toBe(false);
    expect(JSON.parse(grep.output).matches[0]).toMatchObject({ file: "a.txt", line: 1, text: "hello" });
    const list = await executeTool("list_dir", {}, ctx);
    expect(list.isError).toBe(false);
    expect(JSON.parse(list.output)).toMatchObject({ path: ".", entries: [{ name: "a.txt", type: "file" }] });
    expect(TOOL_DEFS.find((tool) => tool.name === "list_dir")!.parameters.required ?? []).not.toContain("path");
  });

  it("keeps bounded unknown-tool errors", async () => {
    const result = await executeTool("unknown" + "x".repeat(4000), undefined, { roots: { self: root() } });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.output).error).toMatch(/^unknown tool:/);
    expect(Buffer.byteLength(result.output)).toBeLessThan(2100);
  });

  it("returns valid argument objects unchanged and leaves numeric ranges to their tools", async () => {
    const args = { path: "a.txt", repo: "self", start: 1, end: 2 };
    const validated = validateToolArgs("read_file", args);
    expect(validated).toEqual({ ok: true, args });
    if (validated.ok) expect(validated.args).toBe(args);
    expect(validateToolArgs("grep", { pattern: "hello", max_results: 1.5 }).ok).toBe(true);
    const result = await executeTool("read_file", { path: "a.txt", start: 1.5 }, { roots: { self: root() } });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.output).error).toContain("invalid line range");
  });
});

const providers = [
  { style: "openai-chat", call: callChatTurn, path: "/chat/completions", envelope: (id: string, args: string) => ({
    choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [
      { id, type: "function", function: { name: "grep", arguments: args } },
    ] } }],
  }) },
  { style: "openai-responses", call: callResponsesTurn, path: "/responses", envelope: (id: string, args: string) => ({
    status: "completed", output: [
      { type: "reasoning", id: "opaque", encrypted_content: "signed" },
      { type: "function_call", call_id: id, name: "grep", arguments: args },
    ],
  }) },
] as const;
describe.each(providers)("$style malformed wire arguments", ({ style, call, path, envelope }) => {
  it("pairs malformed JSON with an error and permits a following valid round", async () => {
    let requests = 0;
    const bodies: any[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      requests++;
      const json = requests === 1 ? envelope("bad", "{") : requests === 2
        ? envelope("good", '{"pattern":"hello"}') : style === "openai-chat"
          ? { choices: [{ finish_reason: "stop", message: { content: '{"findings":[]}' } }] }
          : { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: '{"findings":[]}' }] }] };
      return new Response(JSON.stringify(json), { status: 200 });
    });
    const endpoint: ResolvedEndpoint = { baseUrl: "https://fixture.test", path, headers: {}, apiStyle: style };
    const conv: Conversation = { system: "s", user: "u", tools: [...TOOL_DEFS] };
    const out = await runAgent(conv, { roots: { self: root() } }, { maxTurns: 5, maxSeconds: 120, timeoutSeconds: 5 }, {
      call: (conversation, flags, options) => call(endpoint, conversation, {
        ...options, model: "fixture", provider: "fixture", apiKey: "fixture", maxTokens: 100,
      }, flags), log: () => {},
    });
    expect(out.result).toEqual({ ok: true, findings: [] });
    expect(out.calls).toBe(2);
    const assistant = conv.turns![0]!;
    expect(assistant).toMatchObject({ role: "assistant", toolCalls: [{ id: "bad", args: undefined, rawArgs: "{" }] });
    const tools = conv.turns!.filter((turn) => turn.role === "tool");
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({ id: "bad", isError: true });
    expect(JSON.parse(tools[0]!.output).error).toMatch(/invalid.*argument/i);
    expect(tools[1]).toMatchObject({ id: "good" });
    expect(JSON.parse(tools[1]!.output).matches[0]).toMatchObject({ text: "hello" });
    if (style === "openai-chat") {
      expect(bodies[1].messages[2].tool_calls[0].function.arguments).toBe("{");
      expect(bodies[1].messages[3]).toMatchObject({ role: "tool", tool_call_id: "bad", content: tools[0]!.output });
    } else {
      expect(bodies[1].input.slice(2)).toEqual([
        { type: "reasoning", id: "opaque", encrypted_content: "signed" },
        { type: "function_call", call_id: "bad", name: "grep", arguments: "{" },
        { type: "function_call_output", call_id: "bad", output: tools[0]!.output },
      ]);
    }
  });
});

it("counts invalid attempts against per-turn and turn budgets with paired errors", async () => {
  const invalidCalls = Array.from({ length: 6 }, (_, i) => ({ id: String(i), name: "grep", args: undefined, rawArgs: "{" }));
  const conv: Conversation = { system: "s", user: "u" };
  let requests = 0;
  const out = await runAgent(conv, { roots: { self: root() } }, { maxTurns: 1, maxSeconds: 120, timeoutSeconds: 5 }, {
    call: async (_conv, flags) => {
      requests++;
      if (requests === 1) return { ok: true, text: "", toolCalls: invalidCalls };
      expect(flags.allowTools).toBe(false);
      return { ok: true, text: '{"findings":[]}', toolCalls: [] };
    }, log: () => {},
  });
  expect(out.stop).toBe("budget");
  expect(out.calls).toBe(4);
  const tools = conv.turns!.filter((turn) => turn.role === "tool");
  expect(tools.map((turn) => turn.id)).toEqual(["0", "1", "2", "3", "4", "5"]);
  expect(tools.every((turn) => turn.isError)).toBe(true);
  for (const turn of tools.slice(0, 4)) expect(JSON.parse(turn.output).error).toMatch(/invalid.*argument/i);
  for (const turn of tools.slice(4)) expect(JSON.parse(turn.output).error).toContain("too many tool calls");
});

it.each([
  { style: "anthropic-messages", call: callMessagesTurn, wire: { type: "message", stop_reason: "tool_use", content: [
    { type: "thinking", thinking: "opaque", signature: "signed" },
    { type: "tool_use", id: "bad", name: "list_dir", input: null },
  ] }, rawKey: "content" },
  { style: "google-models", call: (...args: Parameters<typeof callMessagesTurn>) => callGoogleTurn(args[0], "fixture", args[1], args[2], args[3]), wire: { candidates: [{ finishReason: "STOP", content: { parts: [
    { text: "opaque", thoughtSignature: "signed" },
    { functionCall: { id: "bad", name: "list_dir", args: null } },
  ] } }] }, rawKey: "parts" },
] as const)("preserves $style opaque raw history when normalized arguments are invalid", async ({ style, call, wire, rawKey }) => {
  let body: any;
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    body = JSON.parse(String(init.body));
    return new Response(JSON.stringify(wire), { status: 200 });
  });
  const endpoint: ResolvedEndpoint = { baseUrl: "https://fixture.test", path: "/fixture", headers: {}, apiStyle: style };
  const conv: Conversation = { system: "s", user: "u", tools: [...TOOL_DEFS] };
  const opts = { model: "fixture", apiKey: "fixture", maxTokens: 100, timeoutSeconds: 5 };
  const reply = await call(endpoint, conv, opts, { allowTools: true, allowFormat: false });
  expect(reply.ok).toBe(true);
  if (!reply.ok) return;
  expect(reply.toolCalls[0]!.args).toBeNull();
  expect(reply.rawItems).toEqual(rawKey === "content" ? (wire as any).content : (wire as any).candidates[0].content.parts);
  const result = await executeTool("list_dir", reply.toolCalls[0]!.args, { roots: { self: root() } });
  expect(result.isError).toBe(true);
  conv.turns = [
    { role: "assistant", text: reply.text, toolCalls: reply.toolCalls, rawItems: reply.rawItems },
    { role: "tool", id: "bad", name: "list_dir", output: result.output, isError: true },
  ];
  await call(endpoint, conv, opts, { allowTools: true, allowFormat: false });
  if (style === "anthropic-messages") {
    expect(body.messages[1]).toEqual({ role: "assistant", content: (wire as any).content });
    expect(body.messages[2].content[0]).toMatchObject({ type: "tool_result", tool_use_id: "bad", is_error: true });
  } else {
    expect(body.contents[1]).toEqual({ role: "model", parts: (wire as any).candidates[0].content.parts });
    expect(body.contents[2].parts[0].functionResponse).toMatchObject({ id: "bad", name: "list_dir" });
  }
});
