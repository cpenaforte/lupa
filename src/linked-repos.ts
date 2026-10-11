import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export interface CloneRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface CloneDeps {
  run: (
    cmd: string,
    args: string[],
    o: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
  ) => Promise<CloneRunResult>;
  sizeKb?: (alias: string) => Promise<number | undefined>;
}

const CLONE_TIMEOUT_MS = 60000;

function defaultRun(
  cmd: string,
  args: string[],
  o: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<CloneRunResult> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd: o.cwd, env: o.env, timeout: o.timeoutMs },
      (err: unknown, stdout: string, stderr: string) => {
        if (!err) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        const e = err as { code?: unknown; stdout?: unknown; stderr?: unknown };
        resolve({
          code: typeof e.code === "number" ? e.code : null,
          stdout: typeof e.stdout === "string" ? e.stdout : String(e.stdout ?? ""),
          stderr: typeof e.stderr === "string" ? e.stderr : String(e.stderr ?? ""),
        });
      },
    );
  });
}

function cleanAlias(owner: string, repo: string): string | null {
  // Strip trailing punctuation first so a `.git` suffix followed by sentence
  // punctuation (e.g. `tools.git.`) still has its `.git` recognized; strip
  // punctuation again afterwards to catch what the `.git` removal exposed.
  const trimmedRepo = repo
    .replace(/[.,;:!?)\]'"]+$/, "")
    .replace(/\.git$/i, "")
    .replace(/[.,;:!?)\]'"]+$/, "");
  if (!/[A-Za-z0-9]/.test(owner) || !/[A-Za-z0-9]/.test(trimmedRepo)) return null;
  if (trimmedRepo.length === 0) return null;
  return `${owner}/${trimmedRepo}`;
}

/**
 * Parse `owner/repo` references out of a PR body. GitHub URLs win over bare
 * `owner/repo` mentions; bare mentions are best-effort (a wrong alias such as
 * a relative path like `src/utils` simply fails lazily at clone time).
 */
export function parseLinkedRepos(prBody: string, selfFullName: string, cap = 3): string[] {
  const urlRe = /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/g;
  const bareRe = /(?<![/.\w])([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:#\d+)?(?![/.\w])/g;
  const text = prBody.replace(/```[\s\S]*?```/g, "");
  const self = selfFullName.toLowerCase();
  const seen = new Set<string>();
  const urls: string[] = [];
  const bares: string[] = [];
  const push = (list: string[], alias: string): void => {
    const key = alias.toLowerCase();
    if (key === self || seen.has(key)) return;
    seen.add(key);
    list.push(alias);
  };
  let m: RegExpExecArray | null;
  while ((m = urlRe.exec(text)) !== null) {
    const alias = cleanAlias(m[1], m[2]);
    if (alias) push(urls, alias);
  }
  while ((m = bareRe.exec(text)) !== null) {
    const alias = cleanAlias(m[1], m[2]);
    if (alias) push(bares, alias);
  }
  return [...urls, ...bares].slice(0, cap);
}

function redactToken(s: string, token: string): string {
  if (token === "") return s;
  const b64 = Buffer.from("x-access-token:" + token, "utf8").toString("base64");
  return s.split(token).join("[redacted]").split(b64).join("[redacted]");
}

function dirBytes(root: string): number {
  let total = 0;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of entries) {
      if (d.isSymbolicLink()) continue;
      const p = join(cur, d.name);
      if (d.isDirectory()) {
        stack.push(p);
      } else if (d.isFile()) {
        try {
          total += statSync(p).size;
        } catch {
          // ignore unreadable files
        }
      }
    }
  }
  return total;
}

function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // If removal fails, a partial checkout would remain and the next call
    // would trust it via existsSync — rename it out of the way instead so
    // the next call re-clones rather than using a partial checkout.
    try {
      renameSync(dir, `${dir}.broken-${Date.now()}`);
    } catch {
      // ignore cleanup failures
    }
  }
}

/**
 * Lazily shallow-clone `alias` (`owner/repo`) into `baseDir` and return its
 * directory. Auth uses env git config so the token never appears in
 * argv, the clone URL, or logs. Failures return `{ error }` with the token
 * redacted; oversized repos (pre-check via `sizeKb` or post-clone walk)
 * return `{ error: "repository too large" }`.
 */
export async function ensureLinkedRepo(
  alias: string,
  o: { token: string; baseDir: string; timeoutMs?: number; maxBytes?: number; deps?: CloneDeps },
): Promise<{ dir: string } | { error: string }> {
  const dir = join(o.baseDir, alias.split("/").join("__"));
  if (existsSync(dir)) return { dir };

  const deps: CloneDeps = o.deps ?? { run: defaultRun };

  if (o.maxBytes !== undefined && deps.sizeKb) {
    let kb: number | undefined;
    try {
      kb = await deps.sizeKb(alias);
    } catch {
      kb = undefined;
    }
    if (kb !== undefined && kb > o.maxBytes / 1024) {
      return { error: "repository too large" };
    }
  }

  mkdirSync(o.baseDir, { recursive: true });

  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  if (o.token !== "") {
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "http.extraHeader";
    env.GIT_CONFIG_VALUE_0 =
      "Authorization: Basic " + Buffer.from("x-access-token:" + o.token, "utf8").toString("base64");
  }
  const args = ["clone", "--depth", "1", "--single-branch", `https://github.com/${alias}.git`, dir];

  let result: CloneRunResult;
  try {
    result = await deps.run("git", args, { cwd: o.baseDir, env, timeoutMs: o.timeoutMs ?? CLONE_TIMEOUT_MS });
  } catch (e) {
    result = { code: null, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
  if (result.code !== 0) {
    const detail = redactToken(result.stderr.trim() || "clone failed", o.token);
    removeDir(dir);
    return { error: `repository not accessible: ${alias}: ${detail}` };
  }

  if (o.maxBytes !== undefined) {
    let total: number;
    try {
      total = dirBytes(dir);
    } catch {
      removeDir(dir);
      return { error: `repository not accessible: ${alias}: could not measure checkout size` };
    }
    if (total > o.maxBytes) {
      removeDir(dir);
      return { error: "repository too large" };
    }
  }

  return { dir };
}
