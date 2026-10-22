import type { FileDiff } from "../domain/diff.js";
import type { AnalysisAssessment, CoverageIssue } from "../domain/assessment.js";
import { assessAnalysis } from "../domain/assessment.js";
import { filterForPrompt, isLockfile, truncateDiff } from "../diff/patch.js";

export interface DiffProjection {
  text: string;
  skipped: string[];
  eligibleFiles: number;
  eligibleHunks: number;
  includedFiles: number;
  includedHunks: number;
  issues: CoverageIssue[];
}

/** Preserve the prompt's greedy fill while accounting only for complete hunks. */
export function projectDiff(files: FileDiff[], maxChars: number, perFile: number): DiffProjection {
  const eligible = filterForPrompt(files);
  const projected = truncateDiff(eligible, maxChars, perFile);
  const issues: CoverageIssue[] = files.filter(f => !eligible.includes(f) && !isLockfile(f.file))
    .map(f => ({ code: "unsupported-path", file: f.file, message: "Filtered content has no applicable semantic analyzer." }));
  let eligibleHunks = 0, includedHunks = 0, includedFiles = 0, used = 0;
  for (const f of eligible) {
    const starts = [...f.hunks.matchAll(/^@@ .*@@.*$/gm)].map(m => m.index!);
    eligibleHunks += starts.length;
    const section = `--- ${f.file}\n${f.hunks}\n`;
    const size = Math.min(section.length, perFile);
    if (used + size > maxChars) {
      issues.push({ code: "file-omitted", file: f.file, message: `${starts.length} hunk(s) omitted by the total diff budget.` });
      continue;
    }
    used += size;
    const available = section.length > perFile ? Math.max(0, perFile - "\n[... truncated ...]\n".length) - `--- ${f.file}\n`.length : f.hunks.length;
    const count = starts.filter((_, n) => (starts[n + 1] ?? f.hunks.length) <= available).length;
    includedHunks += count;
    if (count === starts.length && !f.truncated) includedFiles += 1;
    else issues.push({ code: "hunk-clipped", file: f.file, message: `${starts.length - count} hunk(s) not fully included in the prompt.` });
  }
  return { ...projected, eligibleFiles: eligible.length, eligibleHunks, includedFiles, includedHunks, issues };
}

export function finalizeAssessment(a: AnalysisAssessment): AnalysisAssessment {
  return { ...a, status: assessAnalysis({ ...a, triggered: a.status !== "skipped" }) };
}
