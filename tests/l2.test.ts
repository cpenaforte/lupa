import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectL2Tools, execTool, L2_TIMEOUT_MS, l2Argv, runL2 } from "../src/l2.js";

const tmpDirs: string[] = [];
function makeTmp(files: Record<string, string> = {}, dirs: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), "l2-"));
  tmpDirs.push(dir);
  for (const d of dirs) mkdirSync(join(dir, d), { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

let savedPath: string | undefined;
beforeEach(() => {
  savedPath = process.env.PATH;
});
afterEach(() => {
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("L2 detection by config presence", () => {
  it("detects cargo pair and prettier by markers", () => {
    expect(detectL2Tools("tests/fixtures/rust-node")).toEqual(
      expect.arrayContaining(["cargo-fmt", "cargo-clippy", "prettier"]),
    );
    expect(detectL2Tools("tests/fixtures/empty")).toEqual([]);
  });

  it("detects eslint/ruff markers too", () => {
    expect(detectL2Tools("tests/fixtures/rust-node")).toEqual(expect.arrayContaining(["eslint"]));
    expect(detectL2Tools("tests/fixtures/python")).toEqual(expect.arrayContaining(["ruff"]));
    expect(detectL2Tools("tests/fixtures/gofmt")).toEqual(expect.arrayContaining(["gofmt"]));
  });

  it("detects gofmt+go vet by go.mod and splits argv", () => {
    expect(detectL2Tools("tests/fixtures/go")).toEqual(expect.arrayContaining(["gofmt", "go vet"]));
    expect(l2Argv("go vet")).toEqual({ cmd: "go", args: ["vet", "./..."] });
  });

  it("l2 argv are check-only (never mutate)", () => {
    expect(l2Argv("cargo-fmt")).toEqual({ cmd: "cargo", args: ["fmt", "--check"] });
    expect(l2Argv("cargo-clippy")).toEqual({ cmd: "cargo", args: ["clippy", "--", "-D", "warnings"] });
    expect(l2Argv("prettier")).toEqual({ cmd: "prettier", args: ["--check", "."] });
    expect(l2Argv("gofmt")).toEqual({ cmd: "gofmt", args: ["-l", "."] });
    expect(l2Argv("ruff")).toEqual({ cmd: "ruff", args: ["check", "."] });
    expect(l2Argv("eslint")).toEqual({ cmd: "eslint", args: ["."] });
  });

  describe("pyproject.toml triggers ruff only with a [tool.ruff] table", () => {
    it("bare pyproject.toml does not trigger ruff", () => {
      const dir = makeTmp({ "pyproject.toml": '[project]\nname = "x"\n' });
      expect(detectL2Tools(dir)).not.toContain("ruff");
    });

    it("pyproject.toml with [tool.ruff] triggers ruff", () => {
      const dir = makeTmp({ "pyproject.toml": "[tool.ruff]\nline-length = 100\n" });
      expect(detectL2Tools(dir)).toContain("ruff");
    });

    it("pyproject.toml with only [tool.ruff.lint] triggers ruff", () => {
      const dir = makeTmp({ "pyproject.toml": '[tool.ruff.lint]\nselect = ["E"]\n' });
      expect(detectL2Tools(dir)).toContain("ruff");
    });
  });

  describe("only regular files count as markers", () => {
    it("directories named like markers do not trigger", () => {
      const dir = makeTmp({}, ["Cargo.toml", "package.json", ".prettierrc", ".eslintrc.json", "ruff.toml", "go.mod"]);
      expect(detectL2Tools(dir)).toEqual([]);
    });

    it("a pyproject.toml directory does not trigger ruff", () => {
      const dir = makeTmp({}, ["pyproject.toml"]);
      expect(detectL2Tools(dir)).not.toContain("ruff");
    });
  });
});

describe("runL2 behavior", () => {
  it("missing binary (ENOENT, stubbed spawner) over a go.mod-only dir → []", async () => {
    const calls: string[] = [];
    const spawn = async (cmd: string) => {
      calls.push(cmd);
      return { failure: { code: "ENOENT", signal: null, output: "" }, stdout: "" };
    };
    expect(await runL2("tests/fixtures/go", spawn)).toEqual([]);
    expect(calls).toEqual(["gofmt", "go"]);
  });

  it("missing binary (empty PATH, real spawner) over a go.mod-only dir → []", async () => {
    const emptyBin = makeTmp();
    process.env.PATH = emptyBin;
    expect(await runL2("tests/fixtures/go")).toEqual([]);
  });

  it("fake tool exiting non-zero → exactly one warning finding with rule = tool name", async () => {
    const bin = makeTmp({ gofmt: "#!/bin/sh\necho 'main.go is not gofmt-clean' >&2\nexit 3\n" });
    chmodSync(join(bin, "gofmt"), 0o755);
    process.env.PATH = bin; // `go` is absent here → ENOENT → skipped
    const findings = await runL2("tests/fixtures/go");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: "warning", file: "", rule: "gofmt" });
    expect(findings[0].message).toContain("reported issues (exit 3)");
    expect(findings[0].message).toContain("main.go is not gofmt-clean");
  });

  it("tool killed by a signal → message names the signal, not an exit code", async () => {
    const bin = makeTmp({ gofmt: "#!/bin/sh\nkill -9 $$\n" });
    chmodSync(join(bin, "gofmt"), 0o755);
    process.env.PATH = bin;
    const findings = await runL2("tests/fixtures/go");
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe("gofmt");
    expect(findings[0].message).toContain("killed by signal SIGKILL");
    expect(findings[0].message).not.toContain("reported issues");
  });

  it("non-executable binary (EACCES) → message names the errno, not an exit code", async () => {
    const bin = makeTmp({ gofmt: "not a program\n" });
    chmodSync(join(bin, "gofmt"), 0o644);
    process.env.PATH = bin;
    const findings = await runL2("tests/fixtures/go");
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe("gofmt");
    expect(findings[0].message).toContain("could not run (EACCES)");
  });

  it("clean run (exit 0) → tool invoked via the seam, yields no findings", async () => {
    // Spawner returns { failure: undefined } === exit 0. Recording the call proves the tool was
    // actually invoked (not silently skipped as ENOENT).
    const calls: Array<{ cmd: string; args: string[]; cwd: string; timeoutMs?: number }> = [];
    const spawn = async (cmd: string, args: string[], cwd: string, timeoutMs?: number) => {
      calls.push({ cmd, args, cwd, timeoutMs });
      return { failure: undefined, stdout: "" };
    };
    expect(await runL2("tests/fixtures/go", spawn)).toEqual([]);
    expect(calls).toEqual([
      { cmd: "gofmt", args: ["-l", "."], cwd: "tests/fixtures/go", timeoutMs: L2_TIMEOUT_MS },
      { cmd: "go", args: ["vet", "./..."], cwd: "tests/fixtures/go", timeoutMs: L2_TIMEOUT_MS },
    ]);
  });
  it("gofmt exit 0 with a file list reports one warning per changed file", async () => {
    const spawn = async () => ({ failure: undefined, stdout: "a.go\nsub/b.go\nc.go\n" });
    const findings = await runL2("tests/fixtures/go", spawn, 1000, new Set(["a.go", "sub/b.go"]));
    expect(findings).toEqual([
      { severity: "warning", file: "a.go", rule: "gofmt", message: "gofmt: a.go is not formatted (run gofmt -w a.go)" },
      { severity: "warning", file: "sub/b.go", rule: "gofmt", message: "gofmt: sub/b.go is not formatted (run gofmt -w sub/b.go)" },
    ]);
  });
  it("gofmt ignores unchanged files, empty output, and ./ prefixes", async () => {
    const onlyUnchanged = async () => ({ failure: undefined, stdout: "other.go\n" });
    expect(await runL2("tests/fixtures/go", onlyUnchanged, 1000, new Set(["a.go"]))).toEqual([]);
    const empty = async () => ({ failure: undefined, stdout: "" });
    expect(await runL2("tests/fixtures/go", empty, 1000, new Set(["a.go"]))).toEqual([]);
    const dotted = async () => ({ failure: undefined, stdout: "./a.go\n" });
    expect(await runL2("tests/fixtures/go", dotted, 1000, new Set(["a.go"]))).toEqual([
      { severity: "warning", file: "a.go", rule: "gofmt", message: "gofmt: a.go is not formatted (run gofmt -w a.go)" },
    ]);
    // Omitted changedFiles defaults to an empty set: silence, never a whole-repo dump.
    const listed = async () => ({ failure: undefined, stdout: "a.go\nsub/b.go\n" });
    expect(await runL2("tests/fixtures/go", listed, 1000)).toEqual([]);
  });
  it("gofmt nonzero exit with a file list still reports the files", async () => {
    const spawn = async (cmd: string) =>
      cmd === "gofmt"
        ? { failure: { code: 2, signal: null, output: "boom" }, stdout: "a.go\n" }
        : { failure: undefined, stdout: "" };
    expect(await runL2("tests/fixtures/go", spawn, 1000, new Set(["a.go"]))).toEqual([
      { severity: "warning", file: "a.go", rule: "gofmt", message: "gofmt: a.go is not formatted (run gofmt -w a.go)" },
    ]);
  });
  it("real execTool captures success stdout (shell stub, no Go toolchain)", async () => {
    const bin = makeTmp({ gofmt: "#!/bin/sh\nprintf 'a.go\\n'\n" });
    chmodSync(join(bin, "gofmt"), 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = bin; // `go` is absent here → ENOENT → skipped
    try {
      expect(await runL2("tests/fixtures/go", execTool, 10000, new Set(["a.go"]))).toEqual([
        { severity: "warning", file: "a.go", rule: "gofmt", message: "gofmt: a.go is not formatted (run gofmt -w a.go)" },
      ]);
    } finally {
      process.env.PATH = oldPath;
    }
  });
});

describe("L2 per-tool timeout", () => {
  it("default budget is 10 minutes per tool invocation", () => {
    expect(L2_TIMEOUT_MS).toBe(600_000);
  });

  it("a runaway tool is killed at its timeout and reported as a warning, never a hang", async () => {
    // A `go` stub that sleeps far longer than the budget, first on PATH for this test only.
    const stubDir = mkdtempSync(join(tmpdir(), "l2-stub-"));
    const stub = join(stubDir, "go");
    writeFileSync(stub, `#!${process.execPath}\nsetTimeout(() => {}, 30000);\n`, "utf8");
    chmodSync(stub, 0o755);
    const savedPath = process.env.PATH;
    process.env.PATH = `${stubDir}:${savedPath ?? ""}`;
    try {
      const started = Date.now();
      const findings = await runL2("tests/fixtures/go", execTool, 300);
      expect(Date.now() - started).toBeLessThan(20_000);
      const timed = findings.find((f) => f.rule === "go vet");
      expect(timed).toBeDefined();
      expect(timed?.severity).toBe("warning");
      expect(timed?.message).toContain("timed out after 0.3s");
    } finally {
      process.env.PATH = savedPath;
      rmSync(stubDir, { recursive: true, force: true });
    }
  }, 30_000);
});
