import { describe, expect, it } from "vitest";
import { projectDiff } from "../src/analysis/coverage.js";
import type { FileDiff } from "../src/domain/diff.js";

const file = (file: string, hunks: string): FileDiff => ({ file, hunks, truncated: false });
describe("semantic diff coverage", () => {
  it("does not count a clipped hunk or its file as included", () => {
    const r = projectDiff([file("a.ts", "@@ -0,0 +1,121 @@\n" + Array.from({ length: 120 }, () => "+" + "x".repeat(100)).join("\n") + "\n+DANGER")], 60000, 8000);
    expect(r.text).not.toContain("DANGER");
    expect(r.text).toContain("[... truncated ...]");
    expect(r).toMatchObject({ eligibleFiles: 1, eligibleHunks: 1, includedFiles: 0, includedHunks: 0 });
    expect(r.issues).toEqual([expect.objectContaining({ code: "hunk-clipped", file: "a.ts" })]);
  });
  it("counts only complete hunks before the cap and fills with later small files", () => {
    const small = file("small.ts", "@@ -0,0 +1 @@\n+ok");
    const large = file("large.ts", "@@ -0,0 +1 @@\n+ok\n@@ -10,0 +11 @@\n+" + "x".repeat(300));
    const r = projectDiff([large, file("skip.ts", "@@ -0,0 +1 @@\n+" + "y".repeat(200)), small], 150, 100);
    expect(r).toMatchObject({ eligibleFiles: 3, eligibleHunks: 4, includedFiles: 1, includedHunks: 2, skipped: ["skip.ts"] });
    expect(r.text).toContain("--- small.ts");
  });
  it("excludes supported lockfiles while recording unsupported filtered files separately", () => {
    const r = projectDiff([{ ...file("a.png", ""), binary: true }, file("a.min.js", "@@ -0,0 +1 @@\n+x"), file("package-lock.json", "@@ -0,0 +1 @@\n+{}"), file("a.ts", "@@ -0,0 +1 @@\n+x")], 60000, 8000);
    expect(r).toMatchObject({ eligibleFiles: 1, eligibleHunks: 1, includedFiles: 1, includedHunks: 1 });
    expect(r.issues.map(i => i.file)).toEqual(["a.png", "a.min.js"]);
  });
});
