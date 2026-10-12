import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { effectiveTimeout, ensureLinkedRepo, parseLinkedRepos } from "../src/linked-repos.js";
import type { CloneDeps } from "../src/linked-repos.js";

const created: string[] = [];
function tempRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "lupa-linked-"));
  created.push(d);
  return d;
}
afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

describe("parseLinkedRepos", () => {
  it("parses URLs, strips .git/tree paths and punctuation", () => {
    expect(parseLinkedRepos("see https://github.com/acme/tools/tree/main/x. ok", "me/self")).toEqual([
      "acme/tools",
    ]);
    expect(parseLinkedRepos("depends on https://github.com/acme/tools.git!", "me/self")).toEqual([
      "acme/tools",
    ]);
    expect(parseLinkedRepos("(https://www.github.com/acme/tools/)", "me/self")).toEqual(["acme/tools"]);
    expect(parseLinkedRepos("see https://github.com/acme/tools.git. ok", "me/self")).toEqual([
      "acme/tools",
    ]);
  });

  it("parses bare owner/repo#12 tokens and excludes self", () => {
    expect(parseLinkedRepos("depends on acme/tools#12 please", "me/self")).toEqual(["acme/tools"]);
    expect(parseLinkedRepos("touching me/self and acme/tools here", "me/self")).toEqual(["acme/tools"]);
    expect(parseLinkedRepos("touching ME/SELF here", "me/self")).toEqual([]);
  });

  it("ignores fenced code blocks, non-github hosts and path-like tokens", () => {
    const body = "```\nacme/hidden\n```\nsee /src/utils and src/utils/ plus gitlab.com/foo/bar end";
    expect(parseLinkedRepos(body, "me/self")).toEqual([]);
  });

  it("standalone path-like tokens are best-effort (documented false positive)", async () => {
    expect(parseLinkedRepos("see src/utils here", "me/self")).toEqual(["src/utils"]);
    // A wrong alias fails lazily at clone time and costs nothing outside agent mode.
    const deps: CloneDeps = {
      run: async () => ({ code: 128, stdout: "", stderr: "fatal: repository not found" }),
    };
    const res = await ensureLinkedRepo("src/utils", { token: "", baseDir: tempRoot(), deps });
    expect("error" in res && res.error).toContain("not accessible");
  });

  it("dedups case-insensitively and caps at 3 with URLs first", () => {
    expect(parseLinkedRepos("Acme/Tools and acme/tools", "me/self")).toEqual(["Acme/Tools"]);
    const body =
      "zeta/a and https://github.com/one/r1 https://github.com/two/r2 https://github.com/three/r3 https://github.com/four/r4";
    expect(parseLinkedRepos(body, "me/self")).toEqual(["one/r1", "two/r2", "three/r3"]);
  });
});

describe("ensureLinkedRepo", () => {
  it("ensureLinkedRepo clones with env auth and never puts the token in argv", async () => {
    const baseDir = tempRoot();
    const token = "s3cret-token";
    const expectedDir = join(baseDir, "acme__tools");
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const deps: CloneDeps = {
      run: async (_cmd, args, o) => {
        calls.push({ args, env: o.env });
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const res = await ensureLinkedRepo("acme/tools", { token, baseDir, deps });
    expect(res).toEqual({ dir: expectedDir, sha: "" });
    const cloneCall = calls.find((c) => c.args[0] === "clone");
    expect(cloneCall!.args).toEqual([
      "clone",
      "--depth",
      "1",
      "--single-branch",
      "https://github.com/acme/tools.git",
      expectedDir,
    ]);
    expect(cloneCall!.args.join(" ")).not.toContain(token);
    expect(cloneCall!.env.GIT_CONFIG_VALUE_0).toBe(
      "Authorization: Basic " + Buffer.from("x-access-token:" + token, "utf8").toString("base64"),
    );
    expect(cloneCall!.env.GIT_CONFIG_COUNT).toBe("1");
    expect(cloneCall!.env.GIT_CONFIG_KEY_0).toBe("http.extraHeader");
    // Git introspection for validation/marker carries no token vars.
    for (const c of calls.filter((c) => c.args[0] !== "clone")) {
      expect(c.env.GIT_CONFIG_COUNT).toBeUndefined();
      expect(c.env.GIT_CONFIG_VALUE_0).toBeUndefined();
      expect(c.env.GIT_TERMINAL_PROMPT).toBe("0");
    }
    // A fresh clone records its marker for later validation.
    expect(JSON.parse(readFileSync(join(expectedDir, ".lupa-clone.json"), "utf8"))).toEqual({
      repo: "acme/tools",
      branch: "",
      sha: "",
    });

    // Empty token omits the GIT_CONFIG_* vars.
    let emptyEnv: NodeJS.ProcessEnv = {};
    await ensureLinkedRepo("acme/other", {
      token: "",
      baseDir,
      deps: { run: async (_c, _a, o) => ((emptyEnv = o.env), { code: 0, stdout: "", stderr: "" }) },
    });
    expect(emptyEnv.GIT_CONFIG_COUNT).toBeUndefined();
    expect(emptyEnv.GIT_CONFIG_VALUE_0).toBeUndefined();
  });

  it("re-clones when the cached dir is not a git repo", async () => {
    const baseDir = tempRoot();
    const dir = join(baseDir, "cached__repo");
    // A plain dir (no .git, no marker): stale content must be wiped, then a
    // fresh clone runs against the untouched destination.
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "stale.txt"), "stale");
    const argv: string[][] = [];
    const deps: CloneDeps = {
      run: async (_cmd, args) => {
        argv.push(args);
        if (args[0] === "clone") {
          mkdirSync(args[args.length - 1]!, { recursive: true });
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const res = await ensureLinkedRepo("cached/repo", { token: "t", baseDir, deps });
    const cloneArgv = argv.find((a) => a[0] === "clone");
    expect(cloneArgv).toEqual([
      "clone",
      "--depth",
      "1",
      "--single-branch",
      "https://github.com/cached/repo.git",
      dir,
    ]);
    expect(res).toEqual({ dir, sha: "" });
    expect(existsSync(join(dir, "stale.txt"))).toBe(false);
  });

  it("re-clones on origin mismatch", async () => {
    const baseDir = tempRoot();
    const dir = join(baseDir, "a__b");
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(
      join(dir, ".lupa-clone.json"),
      JSON.stringify({ repo: "a/b", branch: "main", sha: "0".repeat(40) }),
    );
    const argv: string[][] = [];
    const deps: CloneDeps = {
      run: async (_cmd, args) => {
        argv.push(args);
        if (args[0] === "clone") {
          mkdirSync(args[args.length - 1]!, { recursive: true });
          return { code: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "config") return { code: 0, stdout: "https://github.com/other/repo.git\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const res = await ensureLinkedRepo("a/b", { token: "", baseDir, deps });
    expect(argv.some((a) => a[0] === "clone")).toBe(true);
    expect(res).toEqual({ dir, sha: "" });
    expect(JSON.parse(readFileSync(join(dir, ".lupa-clone.json"), "utf8")).repo).toBe("a/b");
  });

  it("re-clones when rev-parse fails (corrupt .git) without throwing", async () => {
    const baseDir = tempRoot();
    const dir = join(baseDir, "a__b");
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(
      join(dir, ".lupa-clone.json"),
      JSON.stringify({ repo: "a/b", branch: "main", sha: "0".repeat(40) }),
    );
    const argv: string[][] = [];
    const deps: CloneDeps = {
      run: async (_cmd, args) => {
        argv.push(args);
        if (args[0] === "clone") {
          mkdirSync(args[args.length - 1]!, { recursive: true });
          return { code: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "config") return { code: 0, stdout: "https://github.com/a/b.git\n", stderr: "" };
        throw new Error("fatal: not a git repository");
      },
    };
    const res = await ensureLinkedRepo("a/b", { token: "", baseDir, deps });
    expect(argv.some((a) => a[0] === "clone")).toBe(true);
    expect(res).toEqual({ dir, sha: "" });
  });

  it("writes the marker even when the clone ships a marker directory", async () => {
    const baseDir = tempRoot();
    const dir = join(baseDir, "a__b");
    const deps: CloneDeps = {
      run: async (_cmd, args) => {
        if (args[0] === "clone") {
          const dest = args[args.length - 1]!;
          mkdirSync(dest, { recursive: true });
          // Hostile content: the marker path arrives as a directory.
          mkdirSync(join(dest, ".lupa-clone.json"), { recursive: true });
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const res = await ensureLinkedRepo("a/b", { token: "", baseDir, deps });
    expect(res).toEqual({ dir, sha: "" });
    // The marker is a regular file with the fresh-clone payload, not a directory.
    expect(JSON.parse(readFileSync(join(dir, ".lupa-clone.json"), "utf8"))).toEqual({
      repo: "a/b",
      branch: "",
      sha: "",
    });
  });

  it("never writes through a marker symlink outside the clone dir", async () => {
    const baseDir = tempRoot();
    const dir = join(baseDir, "a__b");
    const sentinel = join(baseDir, "sentinel.txt");
    writeFileSync(sentinel, "untouched");
    const deps: CloneDeps = {
      run: async (_cmd, args) => {
        if (args[0] === "clone") {
          const dest = args[args.length - 1]!;
          mkdirSync(dest, { recursive: true });
          // Hostile content: the marker path arrives as a symlink pointing outside.
          symlinkSync(sentinel, join(dest, ".lupa-clone.json"));
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const res = await ensureLinkedRepo("a/b", { token: "", baseDir, deps });
    expect(res).toEqual({ dir, sha: "" });
    expect(readFileSync(sentinel, "utf8")).toBe("untouched");
    // The marker itself is a regular file with the fresh-clone payload.
    expect(statSync(join(dir, ".lupa-clone.json")).isFile()).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, ".lupa-clone.json"), "utf8"))).toEqual({
      repo: "a/b",
      branch: "",
      sha: "",
    });
  });

  it("writes the marker even when the clone ships a fifo at the marker path", async () => {
    const baseDir = tempRoot();
    const dir = join(baseDir, "a__b");
    let fifoPlanted = false;
    const deps: CloneDeps = {
      run: async (_cmd, args) => {
        if (args[0] === "clone") {
          const dest = args[args.length - 1]!;
          mkdirSync(dest, { recursive: true });
          // Hostile content: the marker path arrives as a fifo, whose
          // open(O_WRONLY) would block instead of failing.
          try {
            execFileSync("mkfifo", [join(dest, ".lupa-clone.json")]);
            fifoPlanted = true;
          } catch {
            fifoPlanted = false;
          }
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const res = await ensureLinkedRepo("a/b", { token: "", baseDir, deps });
    if (!fifoPlanted) return; // mkfifo unavailable: nothing hostile to defend against.
    expect(res).toEqual({ dir, sha: "" });
    expect(statSync(join(dir, ".lupa-clone.json")).isFile()).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, ".lupa-clone.json"), "utf8"))).toEqual({
      repo: "a/b",
      branch: "",
      sha: "",
    });
  });

  it("reuses a valid cache with zero git-mutating calls and returns its sha", async () => {
    const baseDir = tempRoot();
    const dir = join(baseDir, "a__b");
    mkdirSync(join(dir, ".git"), { recursive: true });
    // The marker sha is stale on purpose: the sha comes from git, never the marker.
    writeFileSync(
      join(dir, ".lupa-clone.json"),
      JSON.stringify({ repo: "a/b", branch: "main", sha: "0".repeat(40) }),
    );
    const head = "d".repeat(40);
    const argv: string[][] = [];
    const deps: CloneDeps = {
      run: async (_cmd, args, o) => {
        argv.push(args);
        expect(o.cwd).toBe(dir);
        expect(o.env.GIT_CONFIG_COUNT).toBeUndefined();
        expect(o.env.GIT_CONFIG_VALUE_0).toBeUndefined();
        if (args[0] === "config") return { code: 0, stdout: "https://github.com/a/b.git\n", stderr: "" };
        if (args[1] === "--abbrev-ref") return { code: 0, stdout: "main\n", stderr: "" };
        if (args[0] === "rev-parse") return { code: 0, stdout: head + "\n", stderr: "" };
        throw new Error("unexpected git call: " + args.join(" "));
      },
    };
    const res = await ensureLinkedRepo("a/b", { token: "", baseDir, deps });
    expect(res).toEqual({ dir, sha: head });
    expect(argv.some((a) => a[0] === "clone")).toBe(false);
    for (const a of argv) expect(["config", "rev-parse"]).toContain(a[0]);
  });

  it("skips the size check when maxBytes is undefined", async () => {
    const seed = (): { baseDir: string; dir: string } => {
      const baseDir = tempRoot();
      const dir = join(baseDir, "a__b");
      mkdirSync(join(dir, ".git"), { recursive: true });
      writeFileSync(
        join(dir, ".lupa-clone.json"),
        JSON.stringify({ repo: "a/b", branch: "main", sha: "0".repeat(40) }),
      );
      writeFileSync(join(dir, "big.bin"), Buffer.alloc(4096, 1));
      return { baseDir, dir };
    };
    const head = "e".repeat(40);
    const validatingDeps = (argv: string[][]): CloneDeps => ({
      run: async (_cmd, args) => {
        argv.push(args);
        if (args[0] === "clone") {
          mkdirSync(args[args.length - 1]!, { recursive: true });
          return { code: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "config") return { code: 0, stdout: "https://github.com/a/b.git\n", stderr: "" };
        if (args[1] === "--abbrev-ref") return { code: 0, stdout: "main\n", stderr: "" };
        if (args[0] === "rev-parse") return { code: 0, stdout: head + "\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    // No maxBytes: the oversized (but otherwise valid) cache is reused.
    const seeded = seed();
    const reuseArgv: string[][] = [];
    const reused = await ensureLinkedRepo("a/b", {
      token: "",
      baseDir: seeded.baseDir,
      deps: validatingDeps(reuseArgv),
    });
    expect(reused).toEqual({ dir: seeded.dir, sha: head });
    expect(reuseArgv.some((a) => a[0] === "clone")).toBe(false);
    // With maxBytes set: the same layout exceeds the budget and is re-cloned.
    const seeded2 = seed();
    const sizedArgv: string[][] = [];
    const resized = await ensureLinkedRepo("a/b", {
      token: "",
      baseDir: seeded2.baseDir,
      maxBytes: 1024,
      deps: validatingDeps(sizedArgv),
    });
    expect(sizedArgv.some((a) => a[0] === "clone")).toBe(true);
    expect(resized).toEqual({ dir: seeded2.dir, sha: head });
  });

  it("ensureLinkedRepo returns not-accessible on failure with token redacted", async () => {
    const baseDir = tempRoot();
    const token = "s3cret-token";
    const deps: CloneDeps = {
      run: async () => ({ code: 128, stdout: "", stderr: `fatal: could not read '${token}'` }),
    };
    const res = await ensureLinkedRepo("acme/missing", { token, baseDir, deps });
    expect("error" in res).toBe(true);
    const error = (res as { error: string }).error;
    expect(error).toContain("not accessible");
    expect(error).not.toContain(token);
    expect(existsSync(join(baseDir, "acme__missing"))).toBe(false);
  });

  it("ensureLinkedRepo skips oversized repos via sizeKb and post-clone size", async () => {
    const baseDir = tempRoot();
    let ran = false;
    const noRun: CloneDeps = {
      run: async () => ((ran = true), { code: 0, stdout: "", stderr: "" }),
      sizeKb: async () => 2048,
    };
    const skipped = await ensureLinkedRepo("acme/huge", { token: "t", baseDir, maxBytes: 1024, deps: noRun });
    expect(skipped).toEqual({ error: "repository too large" });
    expect(ran).toBe(false);

    const baseDir2 = tempRoot();
    const growing: CloneDeps = {
      run: async (_cmd, args) => {
        const dir = args[args.length - 1];
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "big.bin"), Buffer.alloc(2048, 1));
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const tooBig = await ensureLinkedRepo("acme/grown", { token: "t", baseDir: baseDir2, maxBytes: 1024, deps: growing });
    expect(tooBig).toEqual({ error: "repository too large" });
    expect(existsSync(join(baseDir2, "acme__grown"))).toBe(false);
  });

  it("ensureLinkedRepo redacts the base64 auth header as well as the raw token", async () => {
    const baseDir = tempRoot();
    const token = "s3cret-token";
    const b64 = Buffer.from("x-access-token:" + token, "utf8").toString("base64");
    const deps: CloneDeps = {
      run: async () => ({ code: 128, stdout: "", stderr: `fatal: header '${b64}' rejected for '${token}'` }),
    };
    const res = await ensureLinkedRepo("acme/missing", { token, baseDir, deps });
    expect("error" in res).toBe(true);
    const error = (res as { error: string }).error;
    expect(error).toContain("not accessible");
    expect(error).not.toContain(token);
    expect(error).not.toContain(b64);
  });

  it("ensureLinkedRepo flattens multi-slash aliases instead of nesting dirs", async () => {
    const baseDir = tempRoot();
    const deps: CloneDeps = {
      run: async () => ({ code: 0, stdout: "", stderr: "" }),
    };
    const res = await ensureLinkedRepo("a/b/c", { token: "", baseDir, deps });
    expect(res).toEqual({ dir: join(baseDir, "a__b__c"), sha: "" });
  });
});

describe("deadline-aware linked clones (F11)", () => {
  it("effectiveTimeout clamps to the remaining budget with a floor of 1", () => {
    const now = 1_000_000;
    expect(effectiveTimeout(60000, undefined, now)).toBe(60000);
    expect(effectiveTimeout(60000, now + 5000, now)).toBe(5000);
    expect(effectiveTimeout(60000, now - 1, now)).toBe("expired");
    expect(effectiveTimeout(60000, now, now)).toBe("expired");
    expect(effectiveTimeout(60000, now + 1, now)).toBe(1);
  });

  it("expired deadline on a missing dir errors without spawning git", async () => {
    const baseDir = tempRoot();
    const calls: string[][] = [];
    const deps: CloneDeps = {
      run: async (_cmd, args) => {
        calls.push(args);
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const res = await ensureLinkedRepo("a/b", { token: "", baseDir, deps, deadlineMs: Date.now() - 1000 });
    expect("error" in res ? res.error : "").toContain("deadline exceeded");
    expect(calls).toEqual([]);
  });

  it("expired deadline on a plain dir leaves the dir intact (no wipe)", async () => {
    const baseDir = tempRoot();
    const dir = join(baseDir, "a__b");
    // A plain dir (no .git): the non-deadline path would wipe it and reclone.
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "stale.txt"), "stale");
    const calls: string[][] = [];
    const deps: CloneDeps = {
      run: async (_cmd, args) => {
        calls.push(args);
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const res = await ensureLinkedRepo("a/b", { token: "", baseDir, deps, deadlineMs: Date.now() - 1000 });
    expect("error" in res ? res.error : "").toContain("deadline exceeded");
    expect(calls).toEqual([]);
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(dir, "stale.txt"))).toBe(true);
  });

  it("mid-validation expiry maps to the deadline error without wiping the cache", async () => {
    const baseDir = tempRoot();
    const dir = join(baseDir, "a__b");
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(
      join(dir, ".lupa-clone.json"),
      JSON.stringify({ repo: "a/b", branch: "main", sha: "0".repeat(40) }),
    );
    const argv: string[][] = [];
    const deps: CloneDeps = {
      run: async (_cmd, args) => {
        argv.push(args);
        // Sleep past the 100 ms deadline, then return non-zero as a
        // clamped-timeout kill would. One-sided timing (300 ms sleep vs
        // 100 ms deadline): entry passes, the post-call check finds expiry.
        // Without the per-call re-check this reads as reclone-null and wipes
        // the dir, so the dir-intact assertion is non-vacuous.
        await new Promise((r) => setTimeout(r, 300));
        return { code: 1, stdout: "", stderr: "killed" };
      },
    };
    const res = await ensureLinkedRepo("a/b", { token: "", baseDir, deps, deadlineMs: Date.now() + 100 });
    expect("error" in res ? res.error : "").toContain("deadline exceeded");
    expect(argv.some((a) => a[0] === "clone")).toBe(false);
    expect(existsSync(dir)).toBe(true);
  });
});
