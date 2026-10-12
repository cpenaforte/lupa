# Sub-project F13: read-tool coverage — design

Date: 2026-10-11
Status: design approved (2026-10-11)
Source: Codex audit `PROJECT_FINDINGS.md` (F13), local HEAD `7e4b191`
Goal: stop the agent read tools from concealing uninspected content — separate path
discovery from content eligibility, make line metadata describe the visible result,
and bound traversal before the worker runs.

## Decisions (approved)

- Scope: F13 only (`src/agent-tools.ts` + `tests/agent-tools.test.ts`). No adapter,
  orchestration, template, or CI changes.
- `glob` becomes pure path discovery: names only, no size/binary eligibility
  filtering; response shape `{paths, truncated}` unchanged.
- Bounded walk + explicit counts: `walkFiles`/`walkPaths` take optional
  `limits?: { maxFiles?: number; deadlineMs?: number }` (defaults: 10,000 files,
  10,000 ms wall-clock, checked per directory); prune dependency/vendor dirs
  (`node_modules`, `vendor`, `target`, `.venv`, `venv`, `__pycache__`) in addition
  to the existing `.git`/symlink skips. `dist/`/`build/` are NOT pruned (project
  outputs, sometimes reviewed, usually small).
- `grep` surfaces skip counts; `read_file` recomputes `end_line` from the visible
  content.
- F11 coordination: the `limits` parameter is the interface F11's whole-review
  deadline will later plug into (`deadlineMs` from remaining budget). No F11
  behavior changes now.
- Ship with the whole-plan release — no tag for F13 alone (standing instruction:
  release after the conclusion of the whole roadmap plan).

## 1. Problem

- `glob` reuses the content-eligibility walk (`walkFiles`), so files over 1 MiB and
  binaries are silently omitted from path discovery, with `truncated: false`.
- A truncated `read_file` reports `end_line` of the *selected* lines, not the
  *visible* ones (e.g. `end_line: 400` while visible content ends at 307), so a
  paging agent can skip the missing range.
- `walkFiles` is synchronous and unbounded (no file count, no deadline, no
  vendor pruning); the grep worker timeout does not cover this preliminary walk.

## 2. Design

### Path walk vs content walk

```ts
export interface WalkLimits {
  maxFiles?: number;    // default 10_000 — entries examined (each dequeued entry,
  // files and directories alike; pruned/.git/symlink entries are never examined
  // and never counted), not just returned
  deadlineMs?: number;  // default 10_000 — wall-clock for the walk, checked at the
  // top of each directory iteration including the first (a non-positive deadline
  // fires immediately — test-seam use); known granularity: one synchronous directory
  // read plus its entry loop cannot be preempted, so the walk can overshoot the bound
  // by one directory's processing time
}
export interface WalkSkipped {
  oversized: number;  // > 1 MiB, content walk only
  binary: number;     // NUL in first 8 KB, content walk only
  // Entries still queued (current directory remainder + unvisited directories)
  // at the moment a walk limit fired; pruned/.git/symlink entries are excluded
  // (they are deliberately skipped, not limit-cut). 0 unless a limit fired.
  overLimit: number;
}
```

- `walkPaths(root, startAbs, limits?)`: names only — no `stat` size checks, no
  binary scan. Skips `.git` segments, symlinks, and the prune set. Returns
  `{ paths: string[] (rel, sorted), truncated: boolean, skipped: WalkSkipped }`
  with `oversized`/`binary` always 0 (no eligibility stage) and `overLimit`
  counting unexamined entries on limit hit. `glob` filters by pattern, caps at
  `GLOB_MAX_PATHS` (200), keeps `{paths, truncated}`; `truncated` is true when the
  pattern matches exceed the cap OR the walk hit a limit.
- `walkFiles(root, startAbs, limits?)`: as today (size + binary eligibility) plus
  prune set, `maxFiles`, and `deadlineMs`. `statSync`-failure skips count in no
  bucket. Returns
  `{ files: WalkFile[], truncated: boolean, skipped: WalkSkipped }` with real
  counts. `grepInRoot(root, args, timeoutMs?, limits?)` threads the optional limits
  to its walk, ORs walk truncation into its `truncated` flag and adds the
  `skipped` object to its response: `{matches, truncated, files_scanned, skipped}`.
  The `glob` argument filters after the walk, so `skipped.oversized`/`binary` count
  walk-excluded files even when they would not have matched the glob — the counts
  describe the walk, not the filter (intended: exclusions stay visible regardless of
  the pattern).
  `files_scanned` keeps today's meaning (files the worker attempted to read — the
  counter increments before the read, so read failures count).

### read_file line metadata

`end_line` must describe only *fully visible* lines: after the byte-budget cut, back
the cut up to the last `\n` (`idx = cut.lastIndexOf("\n"); visible = idx < 0 ? "" : cut.slice(0, idx)`)
— a partial tail line still shows characters the metadata would disown, and paging
from `end_line + 1` would drop them. No-newline case: when the cut contains no
`\n` (a single line exceeds the whole budget), `visible` is empty and
`end_line = start - 1` — no complete line is visible, so resuming at `start`
re-reads (overlap) rather than skipping, matching the existing `actualEnd`
convention (`start - 1` when nothing is selected).
`visibleLines = visible === "" ? 0 : visible.split("\n").length` (the backed-up cut
never ends with `\n`, so no boundary over-count), counted over the backed-up portion
only (excluding the appended `\n[truncated]` marker), and
`end_line = visibleLines ? start + visibleLines - 1 : start - 1`.
`start_line`, `total_lines`, and `truncated` are unchanged. A truncated response
therefore never claims a line the agent cannot fully see; resuming at `end_line + 1`
re-reads at worst (overlap), never skips.

### Prune set

`node_modules`, `vendor`, `target`, `.venv`, `venv`, `__pycache__` — matched as
exact entry names (file or directory, any depth), same mechanism as the existing
`.git` entry check. The prune applies to child entries under the walk start; the
start path itself is never pruned (`path: "vendor"` still searches). Case-sensitive
except `.git`, which keeps its case-insensitive rule. Non-regular nodes (fifos,
sockets, and anything that is neither file, dir, nor symlink) are skipped: never
recursed, never listed.

## 3. Tests

`tests/agent-tools.test.ts` (TDD; real temp-dir fixtures):

- `glob` lists a >1 MiB file and a binary file by pattern (pure discovery; both
  present in `paths`, `truncated: false`).
- `glob` omits `node_modules/` and `vendor/` subtrees (prune set) while listing
  sibling source paths.
- `read_file` truncated response: `end_line` equals the last visible numbered
  line (assert against the actual `content` string), `truncated: true`, marker present.
- `read_file` untruncated responses keep today's exact metadata (existing `:50-60`
  test unchanged).
- `grep` on a tree with an oversized + a binary file: response carries
  `skipped: { oversized: 1, binary: 1, overLimit: 0 }`, `files_scanned` counts only
  scanned files.
- Walk file-count limit: a tree exceeding `maxFiles` stops,
  reports `truncated: true` with `overLimit > 0`.
- Existing tests keep passing: `read_file` 1 MiB boundary (`:91-106`), grep
  `.git`/binary skip (`:244`), `matchGlob`, worker timeout/injection,
  symlink tests.

## 4. Verification and release

- Gates: focused `tests/agent-tools.test.ts`, full `vitest`, `tsc --noEmit`,
  `npm run build && node --check dist/index.js`, committed `dist/`.
- No canary (agent tools are exercised by unit fixtures + the deterministic eval
  harness; no test-lupa surface); no tag — ships with the whole-plan release.

## Out of scope

F10/F11/F15 budgets and deadlines (only the `limits` interface is coordinated),
Q01–Q04, F14, template/CI changes, new inputs or dependencies, changing
`list_dir`, `read_file`'s 1 MiB refusal, or grep's worker timeout.
