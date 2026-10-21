import { requestExpired, type RequestContext } from "../runtime/context.js";
import type { ResolvedEndpoint } from "../providers.js";
import { redact } from "../domain/text.js";
import type { Attempt } from "./types.js";

export class OllamaMissingError extends Error {}

const REQUEST_TIMEOUT_HEALTH_MS = 10_000;
const RETRY_BACKOFF_MS = 500;
const MAX_RETRY_AFTER_MS = 5_000;
export const SNIPPET_CHARS = 200;

export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Missing, empty, whitespace-only, non-numeric, or negative Retry-After falls back to the backoff.
 * Values above the cap are clamped to MAX_RETRY_AFTER_MS.
 */
export function retryDelayMs(raw: string | null): number {
  const trimmed = raw?.trim() ?? "";
  if (trimmed === "") return RETRY_BACKOFF_MS;
  const secs = Number(trimmed);
  if (!Number.isFinite(secs) || secs < 0) return RETRY_BACKOFF_MS;
  return Math.min(secs * 1000, MAX_RETRY_AFTER_MS);
}

/** Cancellation resolves sleep early; waitForRetry decides whether work may resume. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

export async function waitForRetry(delayMs: number, context?: RequestContext): Promise<boolean> {
  if (requestExpired(context) || (context !== undefined && delayMs >= context.deadlineMs - Date.now())) return false;
  await sleep(delayMs, context?.signal);
  return !requestExpired(context);
}

export function requestTimeout(): { ok: false; reason: "timeout"; detail: string } {
  return { ok: false, reason: "timeout", detail: "agent budget exhausted" };
}

/**
 * One HTTP attempt. The abort timer covers the headers AND the body read, and is
 * cleared only after the body is fully read.
 */
export async function attempt(ep: ResolvedEndpoint, payload: string, o: { timeoutSeconds: number; apiKey: string; context?: RequestContext }): Promise<Attempt> {
  if (requestExpired(o.context)) return { kind: "fail", result: requestTimeout() };
  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  o.context?.signal.addEventListener("abort", cancel, { once: true });
  const timeoutMs = Math.min(o.timeoutSeconds * 1000, o.context === undefined ? Infinity : o.context.deadlineMs - Date.now());
  const timer = setTimeout(cancel, Math.max(0, timeoutMs));
  try {
    const res = await fetch(`${ep.baseUrl}${ep.path}`, {
      method: "POST",
      headers: { ...ep.headers, "Content-Type": "application/json" },
      body: payload,
      signal: controller.signal,
    });
    const text = await res.text();
    if (controller.signal.aborted || requestExpired(o.context)) return { kind: "fail", result: requestTimeout() };
    return { kind: "response", status: res.status, ok: res.ok, retryAfter: res.headers.get("retry-after"), text };
  } catch (e) {
    if (controller.signal.aborted) {
      return { kind: "fail", result: { ok: false, reason: "timeout", detail: `no complete response within ${o.timeoutSeconds}s` } };
    }
    return {
      kind: "fail",
      result: { ok: false, reason: "http-error", detail: redact(`request failed: ${errMessage(e)}`, o.apiKey) },
    };
  } finally {
    clearTimeout(timer);
    o.context?.signal.removeEventListener("abort", cancel);
  }
}

/** Default client timeout for the Ollama pull (pulls can be slow). */
const PULL_TIMEOUT_DEFAULT_S = 300;

/**
 * Healthchecks the Ollama server at the root (baseUrl minus trailing /v1),
 * then pulls `model` through the REST API under `timeoutSeconds`. A 404 from
 * pull throws OllamaMissingError. Any apiKey given is redacted from error text.
 */
export async function ensureOllama(
  baseUrl: string,
  model: string,
  o: { timeoutSeconds?: number; apiKey?: string } = {},
): Promise<void> {
  const key = o.apiKey ?? "";
  const timeoutSeconds = o.timeoutSeconds ?? PULL_TIMEOUT_DEFAULT_S;
  // Guarded scrub: an empty key must not reach redact (split("") would interleave markers).
  const scrub = (text: string) => (key === "" ? text : redact(text, key));
  const root = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");

  let health: Response;
  try {
    health = await fetch(`${root}/`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_HEALTH_MS) });
  } catch (e) {
    throw new Error(scrub(`Ollama is not reachable at ${root}: ${errMessage(e)}`));
  }
  await health.text().catch(() => "");
  if (!health.ok) {
    throw new Error(`Ollama is not reachable at ${root} (HTTP ${health.status})`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  let pull: Response;
  let text: string;
  try {
    pull = await fetch(`${root}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, stream: false }),
      signal: controller.signal,
    });
    text = await pull.text();
  } catch (e) {
    if (controller.signal.aborted) {
      throw new Error(`ollama pull "${model}" timed out after ${timeoutSeconds}s`);
    }
    throw new Error(scrub(`ollama pull "${model}" failed: ${errMessage(e)}`));
  } finally {
    clearTimeout(timer);
  }

  if (pull.status === 404) {
    throw new OllamaMissingError(`Ollama model "${model}" is not installed and could not be pulled`);
  }
  if (!pull.ok) {
    throw new Error(`ollama pull "${model}" failed with HTTP ${pull.status}`);
  }
  let body: { error?: unknown } | undefined;
  try {
    body = JSON.parse(text) as { error?: unknown };
  } catch {
    body = undefined;
  }
  if (body?.error) {
    throw new Error(scrub(`ollama pull "${model}" failed: ${String(body.error)}`));
  }
}
