/** Absolute wall-clock deadline and cancellation shared by one agent invocation. */
export interface RequestContext {
  deadlineMs: number;
  signal: AbortSignal;
}

export function createRequestContext(timeoutMs: number): { context: RequestContext; dispose(): void } {
  const controller = new AbortController();
  const context = { deadlineMs: Date.now() + timeoutMs, signal: controller.signal };
  const timer = setTimeout(() => controller.abort(), Math.max(0, timeoutMs));
  return { context, dispose: () => clearTimeout(timer) };
}

export function requestExpired(context?: RequestContext): boolean {
  return context !== undefined && (context.signal.aborted || context.deadlineMs <= Date.now());
}
