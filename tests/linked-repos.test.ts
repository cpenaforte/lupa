import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureLinkedRepo, parseLinkedRepos } from "../src/linked-repos.js";
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
    let seenArgs: string[] = [];
    let seenEnv: NodeJS.ProcessEnv = {};
    const deps: CloneDeps = {
      run: async (_cmd, args, o) => {
        seenArgs = args;
        seenEnv = o.env;
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const res = await ensureLinkedRepo("acme/tools", { token, baseDir, deps });
    expect(res).toEqual({ dir: expectedDir });
    expect(seenArgs).toEqual([
      "clone",
      "--depth",
      "1",
      "--single-branch",
      "https://github.com/acme/tools.git",
      expectedDir,
    ]);
    expect(seenArgs.join(" ")).not.toContain(token);
    expect(seenEnv.GIT_CONFIG_VALUE_0).toBe(
      "Authorization: Basic " + Buffer.from("x-access-token:" + token, "utf8").toString("base64"),
    );
    expect(seenEnv.GIT_CONFIG_COUNT).toBe("1");
    expect(seenEnv.GIT_CONFIG_KEY_0).toBe("http.extraHeader");

    // Empty token omits the GIT_CONFIG_* vars.
    let emptyEnv: NodeJS.ProcessEnv = {};
    await ensureLinkedRepo("acme/other", {
      token: "",
      baseDir,
      deps: { run: async (_c, _a, o) => ((emptyEnv = o.env), { code: 0, stdout: "", stderr: "" }) },
    });
    expect(emptyEnv.GIT_CONFIG_COUNT).toBeUndefined();
    expect(emptyEnv.GIT_CONFIG_VALUE_0).toBeUndefined();

    // Already-cloned dir is returned without running git.
    mkdirSync(join(baseDir, "cached__repo"));
    const cached = await ensureLinkedRepo("cached/repo", {
      token,
      baseDir,
      deps: {
        run: async () => {
          throw new Error("must not run when dir exists");
        },
      },
    });
    expect(cached).toEqual({ dir: join(baseDir, "cached__repo") });
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
    expect(res).toEqual({ dir: join(baseDir, "a__b__c") });
  });
});
