# Sub-project F09: Go formatting results — design

Date: 2026-10-11
Status: design approved (2026-10-11)
Source: Codex audit `PROJECT_FINDINGS.md` (F09), local HEAD `342155a`
Goal: report `gofmt -l` formatting drift as findings instead of silently discarding it.

## Decisions (approved)

- Scope: F09 only (`gofmt` success-stdout interpretation). Other native tools keep
  byte-identical behavior through a default interpreter; the registry documents the
  pattern for future per-tool interpreters.
- Severity: `warning` (consistent with every other L2 finding; exit 2 is non-blocking
  by template design, so no merge is held up).
- Scope of files: PR-changed files only (pre-existing drift stays out of the review).
  The changed set flows into `runL2`. (Note: gofmt findings carry no `line`, so
  `mapToComments` always places them in the general body — never inline.)
- Ship with the whole-plan release — no tag for F09 alone (standing instruction:
  release after the conclusion of the whole roadmap plan).

## 1. Problem

`runOne` (`src/l2.ts:141`) maps a `Spawner` result to a finding. `execTool` resolves
`undefined` on success, discarding stdout — so `gofmt -l .`, which signals drift via
successful stdout containing filenames, always yields nothing. The existing Go test
uses an artificial nonzero exit and misses the real contract entirely.

## 2. Design

### Spawner return type

```ts
export interface SpawnResult {
  failure: ToolFailure | undefined;
  /** Captured stdout on both paths (empty string when none). */
  stdout: string;
}
export type Spawner = (
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs?: number,
) => Promise<SpawnResult>;
```

`execTool` captures stdout on success (resolving `{ failure: undefined, stdout }`) and
on failure (existing combined output stays on `failure.output`; `stdout` carries the
raw stdout for interpreters). All spawner fakes in `tests/l2.test.ts` move to the new
shape; `Spawner` consumers are only `src/l2.ts` and `tests/l2.test.ts`.

### Interpreter registry

```ts
type Interpreter = (
  name: string,
  failure: ToolFailure | undefined,
  stdout: string,
  changedFiles: Set<string>,
) => Finding[];
```

- `interpretGofmt`: split stdout on newlines, drop empties, strip a leading `./`,
  intersect with `changedFiles`; one finding per surviving file:
  `{ severity: "warning", file: <path>, rule: "gofmt",
     message: "gofmt: <path> is not formatted (run gofmt -w <path>)" }`.
  Runs regardless of exit code.
- `interpretDefault` (all other tools, byte-identical to today): `undefined` failure
  or `ENOENT` → no finding; otherwise the single generic warning via the existing
  `describeFailure` + first-5-lines detail.
- `runOne` looks up the interpreter by tool name (default fallback), so a nonzero
  exit with an empty/unparseable file list still yields today's generic finding,
  while timeouts and signal kills are unaffected (their stdout carries no file list).

### Changed-file plumbing

```ts
export async function runL2(
  dir: string,
  spawn: Spawner = execTool,
  timeoutMs: number = L2_TIMEOUT_MS,
  changedFiles: Set<string> = new Set(),
): Promise<Finding[]>
```

`Analysis.runL2` (`src/main.ts:88`) gains the same optional parameter;
`realAnalysis` passes it through; the `runFlowA` call site (`:791`) passes
`new Set(files.map((f) => f.file))` from the already-parsed diff (repo-relative
paths, matching `gofmt -l .` output relative to `workDir`). An empty or omitted
`changedFiles` yields no gofmt findings (the intersection is empty). Existing
`runL2(dir)` fakes keep compiling, but the recording fake at
`tests/main.test.ts:274` must capture the second argument (new `Rec` field beside
`l2Env` at `:84`) for the test below.

### Path contract

`gofmt -l .` with cwd `workDir` prints repo-relative paths (`main.go`,
`sub/dir.go`). Normalization strips a leading `./` only; anything not in
`changedFiles` after normalization is skipped silently (no finding, no warning).

## 3. Tests

`tests/l2.test.ts` (TDD; fake spawners in the new `SpawnResult` shape):

- exit 0 with `a.go\nsub/b.go\n` on stdout and changed `{a.go, sub/b.go, c.go}` →
  exactly two findings, `{severity:"warning", file:"a.go", rule:"gofmt"}` and the
  `sub/b.go` twin, messages `gofmt: <path> is not formatted (run gofmt -w <path>)`.
- real-`execTool` success stdout is captured: a shell-stub `gofmt` that prints a
  filename and exits 0 (same stub pattern as the `:101-110` test — no Go toolchain
  needed) yields the per-file finding through the real runner, pinning the
  `execTool` success path that is the actual defect.
- exit 0 with stdout listing only unchanged files → no findings.
- exit 0 with empty stdout → no findings.
- nonzero exit WITH filenames on stdout → per-file findings (pins the
  regardless-of-exit-code behavior).
- exit 3 with `main.go is not gofmt-clean` on stderr and empty stdout → the existing
  generic warning (existing test at `:102-109` keeps passing as-is; it drives the real
  `execTool` against a shell stub, not a fake spawner).
- `./`-prefixed entries (`./a.go`) normalize and match.
- `tests/main.test.ts`: one test asserting the parsed-diff changed set reaches
  `analysis.runL2` as its second argument.

## 4. Verification and release

- Gates: focused `tests/l2.test.ts` + `tests/main.test.ts`, full `vitest`,
  `tsc --noEmit`, `npm run build && node --check dist/index.js`, committed `dist/`.
- No local gofmt on dev machines: verification is fixture-pinned; where a Go
  toolchain exists, an optional uncommitted scratch run against a real `gofmt`
  binary confirms the stdout contract (never committed).
- No canary on test-lupa (no Go sources there); no tag — ships with the whole-plan
  release.

## Out of scope

Other per-tool interpreters (cargo-fmt, prettier, eslint, ruff, clippy, go vet keep
the default), F10/F11/F13/F15, Q01–Q04, F14, the measurement harness, template or CI
changes, new inputs or dependencies.
