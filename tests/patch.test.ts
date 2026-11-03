import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDiffFiles, parsePatch, unquoteGitPath } from "../src/diff/patch.js";

const paths = readFileSync(new URL("./fixtures/patch/paths.patch", import.meta.url), "utf8");
const spaced = "diff --git a/src b/code.ts b/src b/code.ts\n--- a/src b/code.ts\n+++ b/src b/code.ts\n@@ -0,0 +1 @@\n+danger();\n";

describe("authoritative Git patch paths", () => {
  it("uses file metadata instead of a greedy header separator", () => {
    expect(parseDiffFiles(spaced)[0]?.file).toBe("src b/code.ts");
  });

  it("preserves mixed quoted rename metadata", () => {
    expect(parseDiffFiles(paths).find((f) => f.file === 'new"file.ts')).toMatchObject({ file: 'new"file.ts', oldFile: "old file.ts" });
  });

  it("decodes literal supplementary Unicode without splitting its surrogate pair", () => {
    expect(unquoteGitPath('"b/emoji😀\\"file.ts"')).toBe('b/emoji😀"file.ts');
  });

  it("preserves a leading UTF-8 BOM code point in quoted rename metadata", () => {
    const parsed = parsePatch('diff --git a/old.ts "b/\\357\\273\\277new.ts"\nrename from old.ts\nrename to "\\357\\273\\277new.ts"\n');
    expect(parsed.files[0]).toMatchObject({ file: "\uFEFFnew.ts", oldFile: "old.ts" });
  });

  it("parses exact current and old paths from portable Git metadata", () => {
    const parsed = parsePatch(paths);
    expect(parsed.issues).toEqual([]);
    expect(parsed.files.map(({ file, oldFile, deleted, binary }) => ({ file, oldFile, deleted, binary }))).toEqual([
      { file: "café.ts", oldFile: undefined, deleted: undefined, binary: undefined },
      { file: 'emoji😀"file.ts', oldFile: undefined, deleted: undefined, binary: undefined },
      { file: "gone.ts", oldFile: undefined, deleted: true, binary: undefined },
      { file: "image.bin", oldFile: undefined, deleted: undefined, binary: true },
      { file: "mode b/file.ts", oldFile: undefined, deleted: undefined, binary: undefined },
      { file: 'new"file.ts', oldFile: "old file.ts", deleted: undefined, binary: undefined },
      { file: "src b/code.ts", oldFile: undefined, deleted: undefined, binary: undefined },
    ]);
    expect(parsed.files[0]?.hunks).toContain("++++ b/attacker.ts");
  });

  it("retains good sections and emits one bounded issue per unresolved section", () => {
    const parsed = parsePatch('diff --git a/a b/b b/c b/d\nBinary files a/a b/b and b/c b/d differ\n' +
      'diff --git malformed-secret\nrename from incomplete-secret\n' + spaced);
    expect(parsed.files.map((f) => f.file)).toEqual(["src b/code.ts"]);
    expect(parsed.issues).toEqual([
      { section: 1, code: "ambiguous-path", message: expect.any(String) },
      { section: 2, code: "malformed-section", message: expect.any(String) },
    ]);
    expect(JSON.stringify(parsed.issues)).not.toMatch(/malformed-secret|incomplete-secret|a\/a b\/b/);
    expect(parsed.issues.every((issue) => issue.message.length < 200)).toBe(true);
  });

  it("never treats added hunk text as path, binary, or deletion metadata", () => {
    const parsed = parsePatch(spaced + "++++ b/attacker.ts\n+deleted file mode 100644\n+Binary files a/fake and b/fake differ\n");
    expect(parsed.issues).toEqual([]);
    expect(parsed.files[0]).toMatchObject({ file: "src b/code.ts" });
    expect(parsed.files[0]?.binary).toBeUndefined();
    expect(parsed.files[0]?.deleted).toBeUndefined();
  });

  it("rejects conflicting or incomplete authoritative metadata rather than falling back", () => {
    for (const metadata of ["--- a/a.ts\n", "--- a/a.ts\n+++ b/b.ts\nrename from a.ts\nrename to c.ts\n", '--- "a/bad\\q.ts"\n+++ b/b.ts\n', '--- "a/\\541.ts"\n+++ b/b.ts\n']) {
      const parsed = parsePatch("diff --git a/a.ts b/a.ts\n" + metadata);
      expect(parsed.files).toEqual([]);
      expect(parsed.issues).toEqual([{ section: 1, code: "malformed-section", message: expect.any(String) }]);
    }
  });

  it("uses a header fallback only when its paths have one interpretation", () => {
    expect(parsePatch("diff --git a/mode b/file.ts b/mode b/file.ts\nold mode 100644\nnew mode 100755\n").files[0]?.file).toBe("mode b/file.ts");
    expect(parsePatch('diff --git a/old file.ts "b/new\\"file.ts"\nrename from old file.ts\nrename to "new\\"file.ts"\n').files[0]).toMatchObject({ file: 'new"file.ts', oldFile: "old file.ts" });
  });

  it.skipIf(process.platform !== "linux")("attributes real Git output from an owned temporary repository", () => {
    const root = mkdtempSync(join(tmpdir(), "lupa-patch-git-"));
    const git = (...args: string[]) => execFileSync("git", ["-c", "core.quotePath=false", ...args], { cwd: root, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
    const put = (file: string, text: string | Buffer) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), text); };
    try {
      git("init", "--quiet");
      const names = ["src b/code.ts", "old file.ts", "café.ts", 'emoji😀"file.ts', "gone.ts", "mode b/file.ts", "image.bin"];
      for (const name of names) put(name, name === "image.bin" ? Buffer.from([0, 1]) : `// ${name}\nsafe();\n`);
      git("add", ".");
      git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fixture");
      renameSync(join(root, "old file.ts"), join(root, 'new"file.ts'));
      rmSync(join(root, "gone.ts"));
      chmodSync(join(root, "mode b/file.ts"), 0o755);
      for (const name of ["src b/code.ts", "café.ts", 'emoji😀"file.ts']) put(name, "danger();\n+++ b/attacker.ts\n");
      put("image.bin", Buffer.from([0, 2]));
      git("add", ".");
      for (const quotePath of ["false", "true"]) {
        const patch = git("-c", `core.quotePath=${quotePath}`, "diff", "--cached", "--find-renames");
        const parsed = parsePatch(patch, root);
        expect(parsed.issues).toEqual([]);
        expect(parsed.files.map((f) => f.file).sort()).toEqual(["src b/code.ts", 'new"file.ts', "café.ts", 'emoji😀"file.ts', "gone.ts", "mode b/file.ts", "image.bin"].sort());
        expect(parsed.files.find((f) => f.file === 'new"file.ts')?.oldFile).toBe("old file.ts");
        expect(parsed.files.find((f) => f.file === "gone.ts")?.deleted).toBe(true);
        expect(parsed.files.find((f) => f.file === "image.bin")).toMatchObject({ binary: true, size: 2 });
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
