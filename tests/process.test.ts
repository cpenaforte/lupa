import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createProcessRunner, runProcess } from "../src/runtime/process.js";

function child(pid = 4123) {
  return Object.assign(new EventEmitter(), {
    pid, stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true),
  }) as unknown as ChildProcess;
}
function setup(platform: NodeJS.Platform = "linux") {
  vi.useFakeTimers();
  const proc = child();
  const spawn = vi.fn((_command: string, _args: readonly string[], _options: unknown) => proc);
  const kill = vi.fn();
  const run = createProcessRunner({ spawn, kill, platform });
  return { proc, spawn, kill, run };
}
const options = { cwd: ".", env: { PATH: "/owned-bin" }, timeoutMs: 100, maxBufferBytes: 8 };
afterEach(() => vi.useRealTimers());

describe("owned process lifetime", () => {
  it("latches timeout even when TERM causes a zero close and forces only its owned group after 250ms", async () => {
    const { proc, run, kill, spawn } = setup();
    const pending = run("fixture", [], options);
    await vi.advanceTimersByTimeAsync(100);
    expect(kill.mock.calls).toEqual([[-4123, "SIGTERM"]]);
    proc.emit("close", 0, null);
    await vi.advanceTimersByTimeAsync(249);
    expect(kill).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(kill.mock.calls).toEqual([[-4123, "SIGTERM"], [-4123, "SIGKILL"]]);
    expect(await pending).toMatchObject({ exitCode: 0, timedOut: true, cancelled: false });
    expect(spawn.mock.calls[0]?.[2]).toMatchObject({ detached: true, env: { PATH: "/owned-bin" }, shell: false });
  });

  it("starts cleanup once on abort and bounds a stuck cleanup to 1000ms", async () => {
    const { run, proc } = setup();
    const controller = new AbortController();
    const cleanup = vi.fn(() => new Promise<void>(() => {}));
    const pending = run("fixture", [], { ...options, timeoutMs: 5000, signal: controller.signal, cleanup });
    controller.abort();
    proc.emit("close", 0, null);
    await vi.advanceTimersByTimeAsync(999);
    expect(cleanup).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ cancelled: true, timedOut: false, cleanupFailed: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("surfaces rejected cleanup without leaking its error text", async () => {
    const { run, proc } = setup();
    const pending = run("fixture", [], { ...options, cleanup: async () => { throw Error("secret"); } });
    await vi.advanceTimersByTimeAsync(100);
    proc.emit("close", 0, null);
    await vi.advanceTimersByTimeAsync(250);
    const result = await pending;
    expect(result.cleanupFailed).toBe(true);
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("distinguishes ENOENT from timeout without signalling an unowned group", async () => {
    const { run, proc, kill } = setup();
    Object.defineProperty(proc, "pid", { value: undefined });
    const pending = run("missing", [], options);
    proc.emit("error", Object.assign(new Error("missing"), { code: "ENOENT" }));
    expect(await pending).toMatchObject({ missing: true, timedOut: false, exitCode: null });
    expect(kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("caps each output stream and cannot report overflow as success", async () => {
    const { run, proc } = setup();
    const pending = run("fixture", [], options);
    proc.stdout!.emit("data", Buffer.from("abcdefghijklmnop"));
    proc.stderr!.emit("data", Buffer.from("abcdefghijklmnop"));
    proc.emit("close", 0, null);
    await vi.advanceTimersByTimeAsync(250);
    const result = await pending;
    expect(result.stdout).toBe("abcdefgh");
    expect(result.stderr).toBe("abcdefgh");
    expect(result.exitCode).toBeNull();
  });

  it("does not launch anything for an already aborted request", async () => {
    const { run, spawn } = setup();
    const controller = new AbortController();
    controller.abort();
    expect(await run("fixture", [], { ...options, signal: controller.signal })).toMatchObject({ cancelled: true });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("latches an external abort during timeout cleanup independently", async () => {
    const { run } = setup();
    const controller = new AbortController();
    const pending = run("fixture", [], { ...options, signal: controller.signal });
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await vi.advanceTimersByTimeAsync(250);
    expect(await pending).toMatchObject({ timedOut: true, cancelled: true });
  });

  it("keeps decoded multibyte and malformed output within the byte cap", async () => {
    for (const bytes of [Buffer.from("€€"), Buffer.from([255, 255, 255])]) {
      const { run, proc } = setup();
      const pending = run("fixture", [], { ...options, maxBufferBytes: 2 });
      proc.stdout!.emit("data", bytes);
      proc.emit("close", 0, null);
      await vi.advanceTimersByTimeAsync(250);
      const result = await pending;
      expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(2);
      expect(result.exitCode).toBeNull();
      proc.emit("close", 0, null);
      expect(result.exitCode).toBeNull();
    }
  });

  it("retains known errno but never arbitrary error codes or messages", async () => {
    for (const [code, want] of [["EACCES", "EACCES"], ["secret-value", undefined]]) {
      const { run, proc } = setup();
      Object.defineProperty(proc, "pid", { value: undefined });
      const pending = run("fixture", [], options);
      proc.emit("error", Object.assign(new Error("sensitive diagnostic"), { code }));
      const result = await pending;
      expect(result.errorCode).toBe(want);
      expect(JSON.stringify(result)).not.toContain("sensitive");
      expect(JSON.stringify(result)).not.toContain("secret-value");
    }
  });

  it("Windows requests graceful then forced termination for only its owned PID, with bounded helpers", async () => {
    const { run, spawn, kill } = setup("win32");
    const graceful = child(7001);
    const force = child(7002);
    spawn.mockReturnValueOnce(child()).mockReturnValueOnce(graceful).mockReturnValueOnce(force);
    const pending = run("fixture", [], options);
    await vi.advanceTimersByTimeAsync(100);
    graceful.emit("close", 1);
    await vi.advanceTimersByTimeAsync(250);
    expect(spawn.mock.calls.slice(1).map((call) => call[1])).toEqual([
      ["/PID", "4123", "/T"], ["/PID", "4123", "/T", "/F"],
    ]);
    force.emit("close", 0);
    expect(await pending).toMatchObject({ timedOut: true });
    expect(kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("Windows force-helper failure is incomplete, and a stuck helper is itself killed", async () => {
    const { run, spawn } = setup("win32");
    const helper = child(7001);
    spawn.mockReturnValueOnce(child()).mockReturnValue(helper);
    const pending = run("fixture", [], options);
    await vi.advanceTimersByTimeAsync(600);
    expect(await pending).toMatchObject({ timedOut: true, cleanupFailed: true });
    expect(helper.kill).toHaveBeenCalledWith("SIGKILL");
    expect(vi.getTimerCount()).toBe(0);
  });
});

// Real POSIX evidence: the child's ready line proves SIGTERM handlers are installed.
it.skipIf(process.platform === "win32")("kills a stubborn owned descendant after its parent exits zero, leaving an unrelated process alive", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "lupa-owned-process-"));
  const controller = new AbortController();
  let pid: number | undefined;
  let descendant: number | undefined;
  let ready!: (value: { parent: number; descendant: number }) => void;
  const readiness = new Promise<{ parent: number; descendant: number }>((resolveReady) => { ready = resolveReady; });
  const unrelated = nodeSpawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  const run = createProcessRunner({
    platform: process.platform, kill: process.kill.bind(process),
    spawn: (command, args, childOptions) => {
      const proc = nodeSpawn(command, args, childOptions);
      pid = proc.pid;
      proc.stdout!.once("data", (data: Buffer) => ready(JSON.parse(data.toString())));
      return proc;
    },
  });
  const pending = run(process.execPath, [resolve("tests/fixtures/process/child-tree.mjs")], {
    cwd, env: {}, timeoutMs: 5000, maxBufferBytes: 1024, signal: controller.signal,
  });
  try {
    const ids = await Promise.race([readiness, pending.then(() => { throw Error("fixture exited before ready"); })]);
    descendant = ids.descendant;
    expect(ids.parent).toBe(pid);
    controller.abort();
    const result = await pending;
    expect(result.cancelled).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.cleanupFailed).toBeUndefined();
    const running = (target: number) => {
      try {
        process.kill(target, 0);
        // Linux may retain a terminated orphan as a zombie until its init reaps it.
        if (process.platform === "linux" && /\) Z /.test(readFileSync(`/proc/${target}/stat`, "utf8"))) return false;
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH" || (error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    };
    await vi.waitFor(() => expect(running(descendant!)).toBe(false), { timeout: 1000, interval: 10 });
    expect(running(unrelated.pid!)).toBe(true);
  } finally {
    controller.abort();
    await pending;
    // Both IDs are from detached processes created by this test.
    for (const owned of [pid, unrelated.pid]) {
      if (owned !== undefined) {
        try { process.kill(-owned, "SIGKILL"); } catch {}
      }
    }
    await new Promise<void>((done) => {
      if (unrelated.exitCode !== null || unrelated.signalCode !== null) done();
      else unrelated.once("close", () => done());
    });
    rmSync(cwd, { recursive: true, force: true });
  }
}, 10000);

it("requires explicit env without inheriting parent values", async () => {
  const result = await runProcess(process.execPath, ["-e", "console.log(JSON.stringify(process.env))"], {
    cwd: process.cwd(), env: { ONLY_CHILD: "present" }, timeoutMs: 5000, maxBufferBytes: 1024,
  });
  expect(JSON.parse(result.stdout)).toEqual({ ONLY_CHILD: "present" });
});
