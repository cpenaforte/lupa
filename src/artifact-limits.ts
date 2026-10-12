import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { Finding } from "./fastpath.js";
import { DEFAULT_MAX_ARTIFACT_BYTES } from "./inputs.js";

export type CappedRead = { ok: true; text: string } | { ok: false; oversize: true };

/**
 * Reads at most `maxBytes + 1` bytes from `path`. The allocation is bounded by
 * the file (`Math.min(maxBytes, size) + 1`), never by a bare `max + 1`, so an
 * absurd input value cannot exhaust memory. Short reads accumulate in a loop.
 * Oversize returns `{ ok: false, oversize: true }` without the text; read
 * errors propagate to the caller (never conflated with oversize).
 */
export function readCappedFileSync(path: string, maxBytes: number = DEFAULT_MAX_ARTIFACT_BYTES): CappedRead {
  const fd = openSync(path, "r");
  try {
    const n = Math.min(maxBytes, fstatSync(fd).size) + 1;
    const buf = Buffer.alloc(n);
    let bytesRead = 0;
    while (bytesRead < n) {
      const r = readSync(fd, buf, bytesRead, n - bytesRead, null);
      if (r === 0) break;
      bytesRead += r;
    }
    if (bytesRead > maxBytes) return { ok: false, oversize: true };
    return { ok: true, text: buf.subarray(0, bytesRead).toString("utf8") };
  } finally {
    closeSync(fd);
  }
}

/** Exact oversize text; scanners wrap it in their local `warning("scanner-failed", …)`. */
export function oversizeMessage(source: string, max: number): string {
  return `${source} output exceeds the artifact read limit (${max} bytes); results dropped`;
}

/**
 * Byte pre-check for in-memory artifact texts. `[warning]` when oversize,
 * `undefined` when it fits. Finding objects are built literally.
 */
export function byteCheck(text: string, max: number, source: string): Finding[] | undefined {
  if (Buffer.byteLength(text, "utf8") <= max) return undefined;
  return [{ severity: "warning", file: "", rule: "scanner-failed", message: oversizeMessage(source, max) }];
}
