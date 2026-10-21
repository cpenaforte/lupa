const EXEC_ALLOW: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "LC_ALL",
  "TZ",
  "TMPDIR",
  "GITHUB_WORKSPACE",
  "SYSTEMROOT",
  "WINDIR",
  "TEMP",
  "TMP",
  "PATHEXT",
  "DOCKER_HOST",
  "SEMGREP_BASELINE_COMMIT",
]);
const EXEC_ALLOW_PREFIX = ["RUNNER_"];
/** Deny wins over the allowlist. */
const EXEC_DENY = /TOKEN|KEY|SECRET|PASSWORD|AUTH|^GITHUB_TOKEN$|^ACTIONS_/i;

/** The environment handed to PR-controlled exec: allowlisted names only, never secret-shaped names. */
export function cleanEnvForExec(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || EXEC_DENY.test(k)) continue;
    if (EXEC_ALLOW.has(k.toUpperCase()) || EXEC_ALLOW_PREFIX.some((p) => k.startsWith(p))) out[k] = v;
  }
  return out;
}
/** Native tools receive no ambient secrets; this is not an OS sandbox. */
export interface ExecutionOptions {
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}
