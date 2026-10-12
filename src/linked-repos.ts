import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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

/**
 * Clamps a configured git timeout to the remaining deadline budget.
 * No deadline → the configured value. An exhausted budget
 * (`endMs - nowMs <= 0`) → the `"expired"` sentinel (never spawn).
 * Otherwise the clamped remainder, floored at 1 ms (a bare 0 would mean
 * no-timeout in `execFile`). `nowMs` defaults to wall-clock `Date.now`;
 * tests pass it explicitly for determinism.
 */
export function effectiveTimeout(configuredMs: number, endMs?: number, nowMs: number = Date.now()): number | "expired" {
  if (endMs === undefined) return configuredMs;
  if (endMs - nowMs <= 0) return "expired";
  return Math.max(1, Math.min(configuredMs, endMs - nowMs));
}

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
 * directory plus the checked-out SHA. Auth uses env git config so the token never appears in
 * argv, the clone URL, or logs. Failures return `{ error }` with the token
 * redacted; oversized repos (pre-check via `sizeKb` or post-clone walk)
 * return `{ error: "repository too large" }`.
 *
 * A successful fresh clone records `<cloneDir>/.lupa-clone.json`
 * (`{repo, branch, sha}`); an existing dir is validated before reuse (`.git`
 * present, marker repo match, `remote.origin.url` match, checked-out branch
 * match, size within `maxBytes`). Any mismatch or git error wipes the dir
 * (marker included) and runs the full fresh-clone path. The returned sha is
 * always re-derived from git, never trusted from the marker.
 *
 * An absolute `deadlineMs` epoch (wall-clock `Date.now`) clamps every git
 * timeout via `effectiveTimeout`. An already-expired deadline aborts before
 * any spawn with `repository not accessible: <alias>: deadline exceeded` and
 * never wipes an existing dir; `validateCache` reports expiry distinctly from
 * reclone-`null` so a mid-validation expiry maps to the same error. Only a
 * just-created partial fresh clone is still removed on failure.
 */
export async function ensureLinkedRepo(
  alias: string,
  o: {
    token: string;
    baseDir: string;
    timeoutMs?: number;
    maxBytes?: number;
    deps?: CloneDeps;
    sizeKb?: (alias: string) => Promise<number | undefined>;
    deadlineMs?: number;
  },
): Promise<{ dir: string; sha: string } | { error: string }> {
  const dir = join(o.baseDir, alias.split("/").join("__"));
  const deps: CloneDeps = o.deps ?? { run: defaultRun, ...(o.sizeKb !== undefined ? { sizeKb: o.sizeKb } : {}) };
  const deadlineExceeded = `repository not accessible: ${alias}: deadline exceeded`;

  if (o.deadlineMs !== undefined && o.deadlineMs - Date.now() <= 0) {
    return { error: deadlineExceeded };
  }

  if (existsSync(dir)) {
    const sha = await validateCache(deps, alias, dir, o);
    if (sha === "expired") return { error: deadlineExceeded };
    if (sha !== null) return { dir, sha };
    removeDir(dir);
  }

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

  const cloneTimeout = effectiveTimeout(o.timeoutMs ?? CLONE_TIMEOUT_MS, o.deadlineMs);
  if (cloneTimeout === "expired") {
    return { error: deadlineExceeded };
  }
  let result: CloneRunResult;
  try {
    result = await deps.run("git", args, { cwd: o.baseDir, env, timeoutMs: cloneTimeout });
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

  const head = await cloneHead(deps, dir, o.timeoutMs ?? CLONE_TIMEOUT_MS, o.deadlineMs);
  if (head === "expired") {
    removeDir(dir);
    return { error: deadlineExceeded };
  }
  writeMarker(dir, { repo: alias, branch: head.branch, sha: head.sha });
  return { dir, sha: head.sha };
}

/** Name of the clone marker written inside every fresh clone dir. */
const MARKER_NAME = ".lupa-clone.json";

interface CloneMarker {
  repo: string;
  branch: string;
  sha: string;
}

/**
 * Records the fresh-clone marker. The marker path is untrusted clone content:
 * it may arrive as a directory (which would make `writeFileSync` throw), as a
 * symlink (which would redirect the write outside the clone dir), or as a
 * fifo/socket (where `open(O_WRONLY)` would block or fail). `lstatSync`
 * detects any of these without following links; removing the path first
 * (`rmSync` unlinks the node itself without opening it) guarantees the write
 * creates a fresh regular file. The whole write is best-effort: a missing
 * marker simply fails closed on the next validation (re-clone), so a hostile
 * marker path can never throw or hang on the success path.
 */
function writeMarker(dir: string, marker: CloneMarker): void {
  try {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, MARKER_NAME);
    try {
      const st = lstatSync(path);
      if (st.isSymbolicLink() || st.isDirectory() || st.isFile() || st.isFIFO() || st.isSocket()) {
        rmSync(path, { recursive: true, force: true });
      }
    } catch {
      // No pre-existing marker path: nothing to clear.
    }
    writeFileSync(path, JSON.stringify(marker), "utf8");
  } catch {
    // Degrade to "no marker": the next call re-validates and re-clones.
  }
}

function readMarker(dir: string): CloneMarker | null {
  let raw: string;
  try {
    raw = readFileSync(join(dir, MARKER_NAME), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<CloneMarker>;
    if (typeof parsed.repo !== "string" || typeof parsed.branch !== "string" || typeof parsed.sha !== "string") {
      return null;
    }
    return { repo: parsed.repo, branch: parsed.branch, sha: parsed.sha };
  } catch {
    return null;
  }
}

/**
 * Re-derives the checked-out `{branch, sha}` of a fresh clone for the marker.
 * Introspection failures never throw: an empty branch simply fails closed on
 * the next validation (a fresh clone is still usable without its marker data).
 */
async function cloneHead(
  deps: CloneDeps,
  dir: string,
  timeoutMs: number,
  deadlineMs?: number,
): Promise<{ branch: string; sha: string } | "expired"> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  let branch = "";
  let sha = "";
  try {
    const branchTimeout = effectiveTimeout(timeoutMs, deadlineMs);
    if (branchTimeout === "expired") return "expired";
    const b = await deps.run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir, env, timeoutMs: branchTimeout });
    if (b.code === 0) branch = b.stdout.trim();
    const headTimeout = effectiveTimeout(timeoutMs, deadlineMs);
    if (headTimeout === "expired") return "expired";
    const h = await deps.run("git", ["rev-parse", "HEAD"], { cwd: dir, env, timeoutMs: headTimeout });
    if (h.code === 0) sha = h.stdout.trim();
  } catch {
    // Ignore: the clone itself succeeded, so return what was derived so far.
  }
  return { branch, sha };
}

/**
 * Validates an existing clone dir for reuse. Returns the re-derived HEAD sha,
 * `"expired"` when the deadline lapsed (distinct from reclone-`null`: the
 * caller maps it to the deadline error without wiping the dir), or null when
 * the cache must be wiped and re-cloned. Every mismatch and every git error
 * fails closed to null (a safe re-clone), never to trust. The size check is
 * skipped when `maxBytes` is undefined. Expiry is checked at entry and after
 * EACH validation git call: a clamped-timeout kill returns non-zero/throws,
 * which would otherwise read as `null` and wipe a valid cache. Introspection
 * runs without token vars so no secret reaches the cached repo's git.
 */
async function validateCache(
  deps: CloneDeps,
  alias: string,
  dir: string,
  o: { maxBytes?: number; timeoutMs?: number; deadlineMs?: number },
): Promise<string | null | "expired"> {
  const endMs = o.deadlineMs;
  const isExpired = (): boolean => endMs !== undefined && endMs - Date.now() <= 0;
  if (isExpired()) return "expired";
  if (!existsSync(join(dir, ".git"))) return null;
  const marker = readMarker(dir);
  if (marker === null || marker.repo !== alias) return null;
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  const configured = o.timeoutMs ?? CLONE_TIMEOUT_MS;
  try {
    let timeout = effectiveTimeout(configured, endMs);
    if (timeout === "expired") return "expired";
    const origin = await deps.run("git", ["config", "--get", "remote.origin.url"], { cwd: dir, env, timeoutMs: timeout });
    if (isExpired()) return "expired";
    if (origin.code !== 0 || origin.stdout.trim() !== `https://github.com/${alias}.git`) return null;
    timeout = effectiveTimeout(configured, endMs);
    if (timeout === "expired") return "expired";
    const branch = await deps.run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir, env, timeoutMs: timeout });
    if (isExpired()) return "expired";
    const resolvedBranch = branch.code === 0 ? branch.stdout.trim() : "";
    if (resolvedBranch === "" || resolvedBranch !== marker.branch) return null;
    if (o.maxBytes !== undefined) {
      let total: number;
      try {
        total = dirBytes(dir);
      } catch {
        return null;
      }
      if (total > o.maxBytes) return null;
    }
    timeout = effectiveTimeout(configured, endMs);
    if (timeout === "expired") return "expired";
    const head = await deps.run("git", ["rev-parse", "HEAD"], { cwd: dir, env, timeoutMs: timeout });
    if (isExpired()) return "expired";
    if (head.code !== 0) return null;
    return head.stdout.trim();
  } catch {
    if (isExpired()) return "expired";
    return null;
  }
}
