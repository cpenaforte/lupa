import { closeSync, openSync, readSync } from "node:fs";
import type { Finding } from "./fastpath.js";
import { DEFAULT_MAX_ARTIFACT_BYTES } from "./inputs.js";

export type CappedRead = { ok: true; text: string } | { ok: false; oversize: true };

/**
 * Reads at most `maxBytes + 1` bytes from `path`. Sizing never consults fstat:
 * the file is read in fixed 64 KiB chunks appended to an array, stopping at
 * EOF or as soon as the total exceeds `maxBytes` (so size-0-reporting
 * non-regular files and files that grow mid-read are handled by the loop
 * contract, not by a stale size). Oversize returns `{ ok: false, oversize:
 * true }` without the text; read errors propagate to the caller (never
 * conflated with oversize).
 */
export function readCappedFileSync(path: string, maxBytes: number = DEFAULT_MAX_ARTIFACT_BYTES): CappedRead {
  const fd = openSync(path, "r");
  try {
    const parts: Buffer[] = [];
    let total = 0;
    for (;;) {
      const buf = Buffer.alloc(64 * 1024);
      const r = readSync(fd, buf, 0, buf.length, null);
      if (r === 0) break;
      parts.push(buf.subarray(0, r));
      total += r;
      if (total > maxBytes) return { ok: false, oversize: true };
    }
    return { ok: true, text: Buffer.concat(parts).toString("utf8") };
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
