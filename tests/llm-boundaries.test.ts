import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

describe("LLM boundaries", () => {
  it("preserves InvalidJsonError identity across the schema and compatibility paths", async () => {
    const schema = await import("../src/llm/schema.js");
    const facade = await import("../src/llm.js");
    expect(facade.InvalidJsonError).toBe(schema.InvalidJsonError);
    expect(() => schema.parseContent("not JSON")).toThrow(facade.InvalidJsonError);
    expect(schema.parseContent('```json\n{"findings":[]}\n```')).toEqual({ findings: [] });
  });

  it("preserves OllamaMissingError identity across the transport and compatibility paths", async () => {
    const transport = await import("../src/llm/transport.js");
    const facade = await import("../src/llm.js");
    expect(facade.OllamaMissingError).toBe(transport.OllamaMissingError);
    vi.stubGlobal("fetch", async (url: string) => new Response("", { status: url.endsWith("/api/pull") ? 404 : 200 }));
    await expect(transport.ensureOllama("http://localhost:11434/v1", "missing")).rejects.toBeInstanceOf(facade.OllamaMissingError);
  });

  it("loads schema and HTTP transport without starting GitHub or inference requests", async () => {
    vi.resetModules();
    const requests: unknown[] = [];
    vi.stubGlobal("fetch", (...args: unknown[]) => {
      requests.push(args);
      throw new Error("unexpected network request during import");
    });
    const schema = await import("../src/llm/schema.js");
    const transport = await import("../src/llm/transport.js");
    expect(schema.toFindings({ findings: [] })).toEqual([]);
    expect(transport.retryDelayMs(null)).toBe(500);
    expect(requests).toEqual([]);
  });

  it("keeps adapters, the agent and LLM leaves independent of the compatibility facade", () => {
    const files = [
      "agent.ts", "agent-types.ts", "adapters/google.ts", "adapters/messages.ts", "adapters/responses.ts",
      "llm/types.ts", "llm/schema.ts", "llm/sampling.ts", "llm/transport.ts", "llm/chat.ts", "llm/router.ts",
    ];
    const facade = fileURLToPath(new URL("../src/llm.ts", import.meta.url));
    const violations: string[] = [];
    for (const file of files) {
      const url = new URL(`../src/${file}`, import.meta.url);
      const source = ts.createSourceFile(file, readFileSync(url, "utf8"), ts.ScriptTarget.Latest, true);
      for (const statement of source.statements) {
        if (!(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))) continue;
        const specifier = statement.moduleSpecifier;
        if (specifier === undefined || !ts.isStringLiteral(specifier)) continue;
        if (!specifier.text.startsWith(".")) continue;
        const target = fileURLToPath(new URL(specifier.text.replace(/\.js$/, ".ts"), url));
        if (target === facade) violations.push(`${file}: ${specifier.text}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
