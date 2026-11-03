import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = resolve("src");
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sourceFiles(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : [],
  );
}
type Edge = { specifier: string; runtime: boolean };
function dependencies(source: ts.SourceFile): Edge[] {
  const edges: Edge[] = [];
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const runtime = clause === undefined || (!clause.isTypeOnly &&
        (clause.name !== undefined || bindings === undefined || ts.isNamespaceImport(bindings) ||
          bindings.elements.some((element) => !element.isTypeOnly)));
      edges.push({ specifier: node.moduleSpecifier.text, runtime });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.exportClause;
      const runtime = !node.isTypeOnly && (clause === undefined || ts.isNamespaceExport(clause) ||
        clause.elements.some((element) => !element.isTypeOnly));
      edges.push({ specifier: node.moduleSpecifier.text, runtime });
    } else if (ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
      node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      edges.push({ specifier: node.arguments[0].text, runtime: true });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return edges;
}
const sources = new Map(sourceFiles(root).map((file) => [
  file, ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true),
]));
const edges = new Map([...sources].map(([file, source]) => [file, dependencies(source)]));
const target = (file: string, specifier: string): string => resolve(dirname(file), specifier.replace(/\.js$/, ".ts"));

describe("runtime dependency boundaries", () => {
  it("keeps domain runtime dependencies inside the domain and excludes ambient platform effects", () => {
    const violations: string[] = [];
    for (const [file, source] of sources) {
      if (!file.startsWith(join(root, "domain") + "/")) continue;
      for (const edge of edges.get(file)!) {
        if (edge.runtime && (!edge.specifier.startsWith(".") || !target(file, edge.specifier).startsWith(join(root, "domain") + "/"))) {
          violations.push(relative(root, file) + " -> " + edge.specifier);
        }
      }
      function visit(node: ts.Node): void {
        if (ts.isIdentifier(node) && ["process", "fetch", "XMLHttpRequest", "WebSocket"].includes(node.text)) {
          violations.push(relative(root, file) + ": " + node.text);
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
    expect(violations).toEqual([]);
  });

  it("imports owning leaves instead of main, llm or review compatibility facades", () => {
    const facades = new Set(["main.ts", "llm.ts", "review.ts"].map((name) => join(root, name)));
    const violations = [...edges].flatMap(([file, imports]) => imports
      .filter((edge) => edge.specifier.startsWith(".") && facades.has(target(file, edge.specifier)))
      .map((edge) => relative(root, file) + " -> " + edge.specifier));
    expect(violations).toEqual([]);
  });

  it("has no cycles through runtime imports or re-exports", () => {
    const done = new Set<string>();
    const active: string[] = [];
    const cycles: string[] = [];
    function visit(file: string): void {
      if (active.includes(file)) {
        cycles.push([...active.slice(active.indexOf(file)), file].map((p) => relative(root, p)).join(" -> "));
        return;
      }
      if (done.has(file)) return;
      active.push(file);
      for (const edge of edges.get(file) ?? []) {
        if (edge.runtime && edge.specifier.startsWith(".")) visit(target(file, edge.specifier));
      }
      active.pop();
      done.add(file);
    }
    for (const file of sources.keys()) visit(file);
    expect(cycles).toEqual([]);
  });
});
