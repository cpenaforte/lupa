import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding } from "../domain/finding.js";
import type { PrMeta } from "../domain/diff.js";
import type { DedupVerdicts } from "../llm/types.js";
import { readCappedFileSync } from "../artifact-limits.js";
import { DEFAULT_MAX_ARTIFACT_BYTES } from "../inputs.js";

const SEVERITIES: ReadonlySet<string> = new Set(["info", "warning", "high"]);

export function readDiff(dir: string): string {
  const path = join(dir, "diff.patch");
  if (!existsSync(path)) throw new Error(`lupa: diff.patch not found in ${dir}`);
  return readFileSync(path, "utf8");
}

function isFinding(v: unknown): v is Finding {
  if (typeof v !== "object" || v === null) return false;
  const f = v as Record<string, unknown>;
  return (
    typeof f.severity === "string" &&
    SEVERITIES.has(f.severity) &&
    typeof f.file === "string" &&
    typeof f.rule === "string" &&
    typeof f.message === "string" &&
    (f.line === undefined || (typeof f.line === "number" && Number.isInteger(f.line) && f.line >= 1)) &&
    (f.suggestion === undefined || typeof f.suggestion === "string") &&
    (f.patch === undefined || typeof f.patch === "string") &&
    (f.source === undefined || (typeof f.source === "string" && f.source.length > 0 && f.source.length <= 100)) &&
    (f.confidence === undefined ||
      (typeof f.confidence === "number" && Number.isSafeInteger(f.confidence) && f.confidence >= 0 && f.confidence <= 100)) &&
    (f.evidence === undefined ||
      (typeof f.evidence === "object" &&
        f.evidence !== null &&
        !Array.isArray(f.evidence) &&
        ((f.evidence as Record<string, unknown>).snippet === undefined ||
          typeof (f.evidence as Record<string, unknown>).snippet === "string") &&
        ((f.evidence as Record<string, unknown>).analyzer === undefined ||
          typeof (f.evidence as Record<string, unknown>).analyzer === "string")))
  );
}

export function readFindings(dir: string, maxBytes: number = DEFAULT_MAX_ARTIFACT_BYTES): Finding[] {
  const path = join(dir, "findings.json");
  if (!existsSync(path)) throw new Error(`lupa: findings.json not found in ${dir}`);
  const capped = readCappedFileSync(path, maxBytes);
  if (!capped.ok) throw new Error(`lupa: findings.json exceeds the artifact read limit (${maxBytes} bytes)`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(capped.text);
  } catch {
    throw new Error("lupa: findings.json is malformed JSON");
  }
  if (!Array.isArray(parsed) || !parsed.every(isFinding)) {
    throw new Error("lupa: findings.json does not match the finding contract");
  }
  return parsed;
}

export function writeFindings(dir: string, findings: Finding[]): void {
  writeFileSync(join(dir, "findings.json"), JSON.stringify(findings, null, 2) + "\n", "utf8");
}

/** A present verdicts key must carry the DedupVerdicts shape; anything else throws like any contract violation. */
function isVerdictPair(v: unknown): v is [number, number] {
  return Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number" && Number.isInteger(n) && n >= 0);
}

function isVerdicts(v: unknown): v is DedupVerdicts {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return (
    Array.isArray(r.pairs) &&
    r.pairs.every(isVerdictPair) &&
    Array.isArray(r.links) &&
    r.links.every(isVerdictPair) &&
    typeof r.malformed === "number" &&
    Number.isInteger(r.malformed) &&
    r.malformed >= 0
  );
}

const PR_META_FILE = "pr-meta.json";

export function writePrMeta(m: PrMeta, dir: string): void {
  writeFileSync(join(dir, PR_META_FILE), JSON.stringify(m, null, 2) + "\n", "utf8");
}

/** Returns undefined when no pr-meta file exists; throws when it is malformed. */
export function readPrMeta(dir: string, maxBytes: number = DEFAULT_MAX_ARTIFACT_BYTES): PrMeta | undefined {
  const path = join(dir, PR_META_FILE);
  if (!existsSync(path)) return undefined;
  const capped = readCappedFileSync(path, maxBytes);
  if (!capped.ok) throw new Error(`Invalid ${PR_META_FILE} in ${dir}: exceeds the artifact read limit (${maxBytes} bytes)`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(capped.text);
  } catch {
    throw new Error(`Invalid ${PR_META_FILE} in ${dir}: malformed JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid ${PR_META_FILE} in ${dir}`);
  }
  const v = parsed as Record<string, unknown>;
  if (
    typeof v.pr_number !== "number" ||
    typeof v.head_sha !== "string" ||
    typeof v.base_sha !== "string" ||
    typeof v.head_repo_full_name !== "string" ||
    typeof v.is_fork !== "boolean" ||
    !Number.isInteger(v.pr_number) ||
    v.pr_number < 1 ||
    !/^[0-9a-f]{40}$/i.test(v.head_sha) ||
    !/^[0-9a-f]{40}$/i.test(v.base_sha)
  ) {
    throw new Error(`Invalid ${PR_META_FILE} in ${dir}`);
  }
  if ("verdicts" in v && v.verdicts !== undefined && !isVerdicts(v.verdicts)) {
    throw new Error(`Invalid ${PR_META_FILE} in ${dir}`);
  }
  return {
    pr_number: v.pr_number,
    head_sha: v.head_sha,
    base_sha: v.base_sha,
    head_repo_full_name: v.head_repo_full_name,
    is_fork: v.is_fork,
    ...(v.verdicts !== undefined ? { verdicts: v.verdicts as DedupVerdicts } : {}),
  };
}
