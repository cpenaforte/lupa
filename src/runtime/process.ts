import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { join } from "node:path";
import { constants } from "node:os";
import { StringDecoder } from "node:string_decoder";

export interface ProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxBufferBytes: number;
  signal?: AbortSignal;
  cleanup?: () => Promise<void>;
}

export interface ProcessResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  missing: boolean;
  timedOut: boolean;
  cancelled: boolean;
  /** Owned-resource cleanup rejected or did not complete within its bound. */
  cleanupFailed?: boolean;
  /** Validated Node system errno only; never an arbitrary exception message. */
  errorCode?: string;
}

interface ProcessBoundary {
  spawn: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  kill: (pid: number, signal: NodeJS.Signals) => unknown;
  platform: NodeJS.Platform;
}

const GRACE_MS = 250;
const CLEANUP_MS = 1000;
const ERRNO = new Set(Object.keys(constants.errno));
type ProcessRunner = (command: string, args: readonly string[], options: ProcessOptions) => Promise<ProcessResult>;

/** Injectable OS boundary; clocks use the standard timers (fakeable by callers' tests). */
export function createProcessRunner(boundary: ProcessBoundary = {
  spawn: nodeSpawn, kill: process.kill.bind(process), platform: process.platform,
}): ProcessRunner {
  return async (command, args, options) => {
    const result: ProcessResult = {
      exitCode: null, signal: null, stdout: "", stderr: "",
      missing: false, timedOut: false, cancelled: options.signal?.aborted === true,
    };
    if (result.cancelled) return result;
    const recordError = (error: unknown) => {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (typeof code === "string" && ERRNO.has(code)) result.errorCode = code;
      result.missing = code === "ENOENT";
    };
    return new Promise<ProcessResult>((resolve) => {
      let child: ChildProcess;
      let settled = false;
      let stopping = false;
      let invalidOutput = false;
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const cap = Math.max(0, Math.floor(options.maxBufferBytes));
      const decode = (bytes: Buffer) => {
        const text = new StringDecoder("utf8").write(bytes);
        if (Buffer.byteLength(text) <= cap) return text;
        // Replacement characters for malformed UTF-8 can expand on decoding.
        invalidOutput = true;
        return new StringDecoder("utf8").write(Buffer.from(text).subarray(0, cap));
      };

      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        options.signal?.removeEventListener("abort", abort);
        child?.stdout?.destroy();
        child?.stderr?.destroy();
        // Decode only at the end, avoiding split multibyte chunks and unbounded retention.
        result.stdout = decode(stdout);
        result.stderr = decode(stderr);
        if (invalidOutput) result.exitCode = null;
        resolve(result);
      };

      const boundedCleanup = async (cleanup: () => Promise<void>, budget = CLEANUP_MS) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.resolve().then(cleanup),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("cleanup deadline")), budget);
            }),
          ]);
        } catch {
          result.cleanupFailed = true;
        } finally {
          clearTimeout(timer);
        }
      };

      // taskkill owns only the PID returned by our spawn. No shell/PATH lookup and no
      // broad image-name matching. Its helper process is separately bounded.
      const windowsTree = (force: boolean) => new Promise<void>((resolveTree, rejectTree) => {
        const root = options.env.SystemRoot ?? options.env.SYSTEMROOT ?? "C:\\Windows";
        let helper: ChildProcess;
        try {
          helper = boundary.spawn(join(root, "System32", "taskkill.exe"),
            ["/PID", String(child.pid), "/T", ...(force ? ["/F"] : [])],
            { cwd: options.cwd, env: options.env, shell: false, stdio: "ignore", windowsHide: true });
        } catch { rejectTree(new Error("tree cleanup failed")); return; }
        const timer = setTimeout(() => {
          helper.kill("SIGKILL");
          rejectTree(new Error("tree cleanup deadline"));
        }, GRACE_MS);
        const done = (ok: boolean) => {
          clearTimeout(timer);
          if (ok) resolveTree();
          else rejectTree(new Error("tree cleanup failed"));
        };
        helper.once("error", () => done(false));
        helper.once("close", (code) => done(code === 0));
      });

      const groupSignal = (signal: NodeJS.Signals) => {
        // detached:true below creates the group; never signal any other group/PID.
        if (child.pid === undefined) return;
        try { boundary.kill(-child.pid, signal); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") result.cleanupFailed = true;
        }
      };

      const stop = () => {
        if (settled || stopping) return;
        stopping = true;
        clearTimeout(deadline);
        const cleanup = options.cleanup ? boundedCleanup(options.cleanup) : Promise.resolve();
        let graceful = Promise.resolve();
        if (child.pid !== undefined) {
          if (boundary.platform === "win32") {
            // Ask the entire owned tree to terminate, retaining the root for force
            // termination when graceful taskkill is unsupported by a console child.
            graceful = windowsTree(false).catch(() => undefined);
          } else {
            groupSignal("SIGTERM");
          }
        }
        const forced = new Promise<void>((resolveForce) => {
          setTimeout(() => {
            if (child.pid === undefined) { resolveForce(); return; }
            if (boundary.platform === "win32") {
              void boundedCleanup(() => windowsTree(true)).then(resolveForce);
            } else {
              groupSignal("SIGKILL");
              resolveForce();
            }
          }, GRACE_MS);
        });
        void Promise.all([cleanup, graceful, forced]).then(finish);
      };
      const abort = () => {
        if (settled) return;
        result.cancelled = true;
        stop();
      };
      const capture = (stream: "stdout" | "stderr", chunk: Buffer | string) => {
        if (settled) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const previous = stream === "stdout" ? stdout : stderr;
        const room = Math.max(0, cap - previous.length);
        const next = Buffer.concat([previous, bytes.subarray(0, room)]);
        if (stream === "stdout") stdout = next; else stderr = next;
        if (bytes.length > room) { invalidOutput = true; stop(); }
      };

      try {
        child = boundary.spawn(command, args, {
          cwd: options.cwd, env: options.env, detached: boundary.platform !== "win32",
          shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
        });
      } catch (error) {
        recordError(error);
        finish();
        return;
      }
      child.stdout?.on("data", (chunk: Buffer) => capture("stdout", chunk));
      child.stderr?.on("data", (chunk: Buffer) => capture("stderr", chunk));
      child.once("error", (error: NodeJS.ErrnoException) => {
        if (settled) return;
        recordError(error);
        if (child.pid === undefined) finish(); else stop();
      });
      child.once("exit", (code, signal) => {
        if (settled) return;
        // Descendants can retain stdout/stderr after their parent exits.
        // Keep the actual parent status while still waiting for owned-tree cleanup.
        result.exitCode = code;
        result.signal = signal;
      });
      child.once("close", (code, signal) => {
        if (settled) return;
        result.exitCode = code;
        result.signal = signal;
        if (!stopping) finish();
      });
      deadline = setTimeout(() => {
        result.timedOut = true;
        stop();
      }, Math.max(0, options.timeoutMs));
      options.signal?.addEventListener("abort", abort, { once: true });
      // Close the race between the initial check and listener registration.
      if (options.signal?.aborted) abort();
    });
  };
}

/** Bounded, shell-free execution with an explicit environment and owned termination. */
export const runProcess = createProcessRunner();
