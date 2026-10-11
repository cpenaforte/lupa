import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  semgrepArgv,
  shouldUploadSarif,
  isSameRepo,
  resolveJobs,
  gitleaksArgv,
  trivyArgv,
  sbomArgv,
  osvArgv,
  parseSarif,
  runScanners,
  TRIVY_IMAGE,
  TRIVY_DIGEST,
  OSV_VERSION,
  OSV_DIGEST,
  GITLEAKS_IMAGE,
  GITLEAKS_DIGEST,
  SEMGREP_VERSION,
  runExec,
  fromStdout,
  TOOL_TIMEOUT_MS,
} from "../src/scanners.js";

// Only writeFile is wrapped; everything else passes through. Tests opt into failures.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

// ---- argv / gating / pins ------------------------------------------------

describe("argv builders and gates", () => {
  it("no-token argv uses scan+sarif+baseline-commit and no env", () => {
    const r = semgrepArgv({ baselineSha: "abc", jobs: 4, hasToken: false });
    expect(r.argv).toEqual([
      "scan",
      "--config",
      "p/default",
      "--sarif",
      "--metrics=off",
      "--jobs",
      "4",
      "--baseline-commit",
      "abc",
    ]);
    expect(r.env.SEMGREP_BASELINE_COMMIT).toBeUndefined();
  });

  it("semgrep no-token argv uses --config p/default (auto+metrics=off is invalid)", () => {
    const r = semgrepArgv({ baselineSha: "abc", jobs: 4, hasToken: false });
    expect(r.argv).toContain("p/default");
    expect(r.argv).not.toContain("auto");
  });

  it("token argv uses ci+sarif with baseline env, exact shape", () => {
    const r = semgrepArgv({ baselineSha: "abc", jobs: 4, hasToken: true });
    expect(r.argv).toEqual(["ci", "--sarif", "--metrics=off", "--jobs", "4"]);
    expect(r.env.SEMGREP_BASELINE_COMMIT).toBe("abc");
  });

  it("sbom argv generates cyclonedx via fs scan", () => {
    expect(sbomArgv(".")).toEqual(["fs", "--format", "cyclonedx", "."]);
  });

  it("gitleaks argv uses dir, sarif format and a report path (detect deprecated)", () => {
    expect(gitleaksArgv(".", "/out/report.sarif")).toEqual([
      "dir",
      ".",
      "--report-format",
      "sarif",
      "--report-path",
      "/out/report.sarif",
    ]);
    expect(GITLEAKS_IMAGE).toContain("8.30.1");
    expect(GITLEAKS_DIGEST).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("trivy and osv argv use exact scanner format", () => {
    expect(trivyArgv(".")).toEqual(["fs", "--format", "sarif", "--severity", "HIGH,CRITICAL", "."]);
    expect(osvArgv("package-lock.json")).toEqual(["scan", "-L", "package-lock.json", "--format", "sarif"]);
  });

  it("sarif gated on same-repo + permission + flag; both events covered", () => {
    expect(shouldUploadSarif({ isSameRepo: true, hasPermission: true, codeScanningEnabled: true })).toBe(true);
    expect(shouldUploadSarif({ isSameRepo: false, hasPermission: true, codeScanningEnabled: true })).toBe(false);
    expect(shouldUploadSarif({ isSameRepo: true, hasPermission: false, codeScanningEnabled: true })).toBe(false);
    expect(shouldUploadSarif({ isSameRepo: true, hasPermission: true, codeScanningEnabled: false })).toBe(false);
    expect(isSameRepo("pull_request", { pullHeadRepo: "o/r" }, undefined, "o/r")).toBe(true);
    expect(isSameRepo("pull_request", { pullHeadRepo: "f/r" }, undefined, "o/r")).toBe(false);
    expect(isSameRepo("workflow_run", {}, { head_repo_full_name: "o/r" } as never, "o/r")).toBe(true);
    expect(isSameRepo("workflow_run", {}, { head_repo_full_name: "f/r" } as never, "o/r")).toBe(false);
  });

  it("jobs resolves to a positive int and pins are exported", () => {
    expect(resolveJobs()).toBeGreaterThan(0);
    expect(TRIVY_IMAGE).toContain("0.75.0");
    expect(TRIVY_DIGEST).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(OSV_VERSION).toContain("2.6.0");
    expect(OSV_DIGEST).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(SEMGREP_VERSION).toBe("1.180.0");
  });
});

// ---- SARIF parsing -------------------------------------------------------

describe("parseSarif", () => {
  it("maps SARIF levels to severities and reads location", () => {
    const sarif = JSON.stringify({
      runs: [
        {
          results: [
            {
              ruleId: "R1",
              level: "error",
              message: { text: "bad" },
              locations: [{ physicalLocation: { artifactLocation: { uri: "a.ts" }, region: { startLine: 7 } } }],
            },
            { ruleId: "R2", level: "note", message: { text: "meh" }, locations: [] },
          ],
        },
      ],
    });
    expect(parseSarif(sarif)).toEqual([
      { severity: "high", file: "a.ts", line: 7, rule: "R1", message: "bad" },
      { severity: "info", file: "", rule: "R2", message: "meh" },
    ]);
  });

  it("missing SARIF level defaults to warning", () => {
    const sarif = JSON.stringify({ runs: [{ results: [{ ruleId: "R3", message: { text: "no level" } }] }] });
    expect(parseSarif(sarif)).toEqual([
      { severity: "warning", file: "", rule: "R3", message: "no level" },
    ]);
  });

  it("returns undefined for invalid JSON or a non-SARIF document (never silent [])", () => {
    expect(parseSarif("not json")).toBeUndefined();
    expect(parseSarif("{}")).toBeUndefined();
    expect(parseSarif('{"runs":"x"}')).toBeUndefined();
  });

  it("empty but valid SARIF is a clean result, not a failure", () => {
    expect(parseSarif('{"runs":[]}')).toEqual([]);
  });

  it("parseSarif normalizes /src/ container paths to repo-relative", () => {
    const sarif = JSON.stringify({
      runs: [
        {
          results: [
            {
              ruleId: "G1",
              level: "error",
              message: { text: "secret" },
              locations: [{ physicalLocation: { artifactLocation: { uri: "/src/config.py" }, region: { startLine: 5 } } }],
            },
          ],
        },
      ],
    });
    expect(parseSarif(sarif)).toEqual([
      { severity: "high", file: "config.py", line: 5, rule: "G1", message: "secret" },
    ]);
  });

  it("parseSarif normalizes file:///src/ URIs", () => {
    const sarif = JSON.stringify({
      runs: [
        {
          results: [
            {
              ruleId: "G2",
              level: "error",
              message: { text: "secret" },
              locations: [
                { physicalLocation: { artifactLocation: { uri: "file:///src/config.py" }, region: { startLine: 9 } } },
              ],
            },
          ],
        },
      ],
    });
    expect(parseSarif(sarif)).toEqual([
      { severity: "high", file: "config.py", line: 9, rule: "G2", message: "secret" },
    ]);
  });

  it("parseSarif leaves repo-relative and non-/src absolute paths untouched", () => {
    const sarif = JSON.stringify({
      runs: [
        {
          results: [
            {
              ruleId: "R1",
              level: "error",
              message: { text: "relative" },
              locations: [{ physicalLocation: { artifactLocation: { uri: "a.ts" }, region: { startLine: 1 } } }],
            },
            {
              ruleId: "R2",
              level: "error",
              message: { text: "absolute" },
              locations: [{ physicalLocation: { artifactLocation: { uri: "/usr/lib/x.py" }, region: { startLine: 2 } } }],
            },
          ],
        },
      ],
    });
    expect(parseSarif(sarif)).toEqual([
      { severity: "high", file: "a.ts", line: 1, rule: "R1", message: "relative" },
      { severity: "high", file: "/usr/lib/x.py", line: 2, rule: "R2", message: "absolute" },
    ]);
  });

  it("null-guards runs/results/locations without throwing", () => {
    const sarif = JSON.stringify({
      runs: [null, { results: "x" }, { results: [null, { ruleId: "R", locations: [null, 3] }] }],
    });
    expect(parseSarif(sarif)).toEqual([{ severity: "warning", file: "", rule: "R", message: "scanner finding" }]);
  });
});

// ---- runScanners with fake binaries on PATH ------------------------------

const FAKE_SEMGREP_CLEAN = `#!/bin/sh\nprintf '%s' '{"runs":[]}'\nexit 0\n`;

/**
 * Fake docker. Records every invocation in $SCAN_LOG; answers the CycloneDX request with
 * a JSON document (or, with $SBOM_MODE=fail|garbage, a failure / non-JSON output); with
 * $EMPTY_TRIVY / $EMPTY_OSV the trivy / osv calls exit 5 / 6 with no stdout; for gitleaks
 * (the only call mounting `:/out`) writes a SARIF report unless $NO_REPORT is set; all
 * other calls exit with $FAKE_EXIT (default 0).
 */
const FAKE_DOCKER = `#!/bin/sh
echo "$*" >> "$SCAN_LOG"
case "$*" in
  *cyclonedx*)
    case "$SBOM_MODE" in
      fail) exit 4;;
      garbage) printf '%s' 'nope'; exit 0;;
      valid-nonzero) printf '%s' '{"bomFormat":"CycloneDX"}'; exit 4;;
      no-bomformat) printf '%s' '{}'; exit 0;;
    esac
    printf '%s' '{"bomFormat":"CycloneDX"}'; exit 0;;
  *--severity*) if [ -n "$EMPTY_TRIVY" ]; then exit 5; fi;;
  *" -L "*) if [ -n "$EMPTY_OSV" ]; then exit 6; fi;;
esac
for a in "$@"; do case "$a" in *:/out) host="\${a%:/out}";; esac; done
if [ -n "$host" ]; then
  echo "$host" >> "$SCAN_LOG.reportdirs"
  if [ -z "$NO_REPORT" ]; then
    printf '%s' '{"runs":[{"results":[{"ruleId":"G1","level":"error","message":{"text":"secret"},"locations":[{"physicalLocation":{"artifactLocation":{"uri":"x.env"},"region":{"startLine":2}}}]}]}]}' > "$host/report.sarif"
  fi
fi
printf '%s' '{"runs":[]}'
exit "\${FAKE_EXIT:-0}"
`;

/** Temp dirs created during a test; removed in afterEach so no run leaves scratch dirs behind. */
let created: string[] = [];

function makeBin(scripts: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "scan-bin-"));
  created.push(d);
  for (const [name, body] of Object.entries(scripts)) {
    const p = join(d, name);
    writeFileSync(p, body);
    chmodSync(p, 0o755);
  }
  return d;
}

describe("runScanners", () => {
  let savedPath: string | undefined;
  let savedTmpdir: string | undefined;
  let tmp: string;
  let log: string;

  beforeEach(() => {
    savedPath = process.env.PATH;
    savedTmpdir = process.env.TMPDIR;
    tmp = mkdtempSync(join(tmpdir(), "scan-test-"));
    created = [tmp];
    log = join(tmp, "calls.log");
    process.env.SCAN_LOG = log;
  });

  afterEach(() => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    if (savedTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmpdir;
    for (const k of ["SCAN_LOG", "NO_REPORT", "FAKE_EXIT", "SBOM_MODE", "EMPTY_TRIVY", "EMPTY_OSV"]) {
      delete process.env[k];
    }
    for (const d of created) rmSync(d, { recursive: true, force: true });
    created = [];
  });

  it("missing binaries yield scanner-missing warnings and never throw", async () => {
    process.env.PATH = makeBin({}); // empty PATH dir: semgrep and docker both ENOENT
    const r = await runScanners({
      dir: tmp,
      baselineSha: "abc",
      lockfiles: ["a/package-lock.json"],
      sbom: true,
      outDir: tmp,
    });
    expect(r.findings.length).toBe(5); // semgrep, trivy, gitleaks, osv(a), sbom
    for (const f of r.findings) {
      expect(f.severity).toBe("warning");
      expect(f.rule).toBe("scanner-missing");
    }
    expect(r.sbomPath).toBeUndefined();
  });

  it("parses SARIF from a semgrep run that exits non-zero (findings present)", async () => {
    const sarif = `{"runs":[{"results":[{"ruleId":"S1","level":"error","message":{"text":"sg"},"locations":[{"physicalLocation":{"artifactLocation":{"uri":"a.ts"},"region":{"startLine":3}}}]}]}]}`;
    process.env.PATH = makeBin({
      semgrep: `#!/bin/sh\nprintf '%s' '${sarif}'\nexit 1\n`,
      docker: FAKE_DOCKER,
    });
    const { findings } = await runScanners({ dir: tmp, baselineSha: "abc" });
    expect(findings).toContainEqual({ severity: "high", file: "a.ts", line: 3, rule: "S1", message: "sg" });
    expect(findings.some((f) => f.rule === "scanner-failed")).toBe(false);
  });

  it("non-zero exit with empty stdout is a scanner-failed warning, never a clean pass", async () => {
    process.env.PATH = makeBin({
      semgrep: `#!/bin/sh\nexit 2\n`,
      docker: FAKE_DOCKER,
    });
    const { findings } = await runScanners({ dir: tmp, baselineSha: "abc" });
    expect(findings).toContainEqual({
      severity: "warning",
      file: "",
      rule: "scanner-failed",
      message: "semgrep exited 2 without parseable SARIF",
    });
  });

  it("exit 0 with unparseable stdout is a scanner-failed warning", async () => {
    process.env.PATH = makeBin({
      semgrep: `#!/bin/sh\nprintf '%s' 'garbage'\nexit 0\n`,
      docker: FAKE_DOCKER,
    });
    const { findings } = await runScanners({ dir: tmp, baselineSha: "abc" });
    expect(findings.some((f) => f.rule === "scanner-failed" && f.message.startsWith("semgrep"))).toBe(true);
  });

  it("runs osv-scanner once per lockfile", async () => {
    process.env.PATH = makeBin({ semgrep: FAKE_SEMGREP_CLEAN, docker: FAKE_DOCKER });
    await runScanners({ dir: tmp, baselineSha: "abc", lockfiles: ["a/package-lock.json", "b/Cargo.lock"] });
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain("scan -L a/package-lock.json --format sarif");
    expect(calls).toContain("scan -L b/Cargo.lock --format sarif");
  });

  it("gitleaks reads its report file, parses it and removes the temp dir", async () => {
    process.env.PATH = makeBin({ semgrep: FAKE_SEMGREP_CLEAN, docker: FAKE_DOCKER });
    const { findings } = await runScanners({ dir: tmp, baselineSha: "abc" });
    expect(findings).toContainEqual({ severity: "high", file: "x.env", line: 2, rule: "G1", message: "secret" });
    const reportDir = readFileSync(`${log}.reportdirs`, "utf8").trim();
    expect(reportDir).not.toBe("");
    expect(existsSync(reportDir)).toBe(false);
  });

  it("gitleaks exit 0 with no report is clean; non-zero exit with no report is scanner-failed", async () => {
    process.env.PATH = makeBin({ semgrep: FAKE_SEMGREP_CLEAN, docker: FAKE_DOCKER });
    process.env.NO_REPORT = "1";
    const clean = await runScanners({ dir: tmp, baselineSha: "abc" });
    expect(clean.findings).toEqual([]);

    process.env.FAKE_EXIT = "3";
    const failed = await runScanners({ dir: tmp, baselineSha: "abc" });
    expect(failed.findings).toContainEqual({
      severity: "warning",
      file: "",
      rule: "scanner-failed",
      message: "gitleaks exited 3 with no report",
    });
  });

  it("sbom is written inside a unique mkdtemp dir under outDir and its path is returned", async () => {
    process.env.PATH = makeBin({ semgrep: FAKE_SEMGREP_CLEAN, docker: FAKE_DOCKER });
    const r1 = await runScanners({ dir: tmp, baselineSha: "abc", sbom: true, outDir: tmp });
    const r2 = await runScanners({ dir: tmp, baselineSha: "abc", sbom: true, outDir: tmp });
    expect(r1.sbomPath).toBeDefined();
    expect(r2.sbomPath).toBeDefined();
    const p1 = r1.sbomPath as string;
    expect(basename(p1)).toBe("sbom.cdx.json");
    expect(basename(dirname(p1)).startsWith("sbom-")).toBe(true);
    expect(dirname(dirname(p1))).toBe(tmp);
    expect(p1).not.toBe(r2.sbomPath);
    expect(readFileSync(p1, "utf8")).toBe('{"bomFormat":"CycloneDX"}');
    expect(r1.findings.some((f) => f.rule === "sbom")).toBe(false);
  });

  it("sbom non-zero exit with valid CycloneDX stdout is accepted (parity with SARIF)", async () => {
    process.env.PATH = makeBin({ semgrep: FAKE_SEMGREP_CLEAN, docker: FAKE_DOCKER });
    process.env.SBOM_MODE = "valid-nonzero";
    const r = await runScanners({ dir: tmp, baselineSha: "abc", sbom: true, outDir: tmp });
    expect(r.sbomPath).toBeDefined();
    expect(readFileSync(r.sbomPath as string, "utf8")).toBe('{"bomFormat":"CycloneDX"}');
    expect(r.findings.some((f) => f.rule === "scanner-failed")).toBe(false);
  });

  it("sbom JSON without bomFormat CycloneDX is a scanner-failed warning", async () => {
    process.env.PATH = makeBin({ semgrep: FAKE_SEMGREP_CLEAN, docker: FAKE_DOCKER });
    process.env.SBOM_MODE = "no-bomformat";
    const r = await runScanners({ dir: tmp, baselineSha: "abc", sbom: true, outDir: tmp });
    expect(r.sbomPath).toBeUndefined();
    expect(r.findings).toContainEqual({
      severity: "warning",
      file: "",
      rule: "scanner-failed",
      message: "sbom exited 0 without a CycloneDX document",
    });
  });

  it("sbom writeFile failure removes the sbom dir and returns an sbom-write warning, no throw", async () => {
    process.env.PATH = makeBin({ semgrep: FAKE_SEMGREP_CLEAN, docker: FAKE_DOCKER });
    vi.mocked(writeFile).mockRejectedValueOnce(new Error("disk full"));
    const r = await runScanners({ dir: tmp, baselineSha: "abc", sbom: true, outDir: tmp });
    expect(r.sbomPath).toBeUndefined();
    expect(r.findings).toContainEqual({
      severity: "warning",
      file: "",
      rule: "sbom-write",
      message: "could not write SBOM: disk full",
    });
    expect(readdirSync(tmp).filter((n) => n.startsWith("sbom-"))).toEqual([]);
  });

  it("sbom non-zero exit is a scanner-failed warning and no sbomPath", async () => {
    process.env.PATH = makeBin({ semgrep: FAKE_SEMGREP_CLEAN, docker: FAKE_DOCKER });
    process.env.SBOM_MODE = "fail";
    const r = await runScanners({ dir: tmp, baselineSha: "abc", sbom: true, outDir: tmp });
    expect(r.sbomPath).toBeUndefined();
    expect(r.findings).toContainEqual({
      severity: "warning",
      file: "",
      rule: "scanner-failed",
      message: "sbom exited 4 without a CycloneDX document",
    });
  });

  it("sbom exit 0 with non-JSON stdout is a scanner-failed warning", async () => {
    process.env.PATH = makeBin({ semgrep: FAKE_SEMGREP_CLEAN, docker: FAKE_DOCKER });
    process.env.SBOM_MODE = "garbage";
    const r = await runScanners({ dir: tmp, baselineSha: "abc", sbom: true, outDir: tmp });
    expect(r.sbomPath).toBeUndefined();
    expect(r.findings).toContainEqual({
      severity: "warning",
      file: "",
      rule: "scanner-failed",
      message: "sbom exited 0 without a CycloneDX document",
    });
  });

  it("sbom write failure (outDir missing) is an sbom-write warning, not a throw", async () => {
    process.env.PATH = makeBin({ semgrep: FAKE_SEMGREP_CLEAN, docker: FAKE_DOCKER });
    const r = await runScanners({ dir: tmp, baselineSha: "abc", sbom: true, outDir: join(tmp, "missing") });
    expect(r.sbomPath).toBeUndefined();
    expect(r.findings.some((f) => f.rule === "sbom-write" && f.severity === "warning")).toBe(true);
  });

  it("trivy non-zero exit with empty stdout is a warning", async () => {
    process.env.PATH = makeBin({ semgrep: FAKE_SEMGREP_CLEAN, docker: FAKE_DOCKER });
    process.env.EMPTY_TRIVY = "1";
    const { findings } = await runScanners({ dir: tmp, baselineSha: "abc" });
    expect(findings).toContainEqual({
      severity: "warning",
      file: "",
      rule: "scanner-failed",
      message: "trivy exited 5 without parseable SARIF",
    });
  });

  it("osv non-zero exit with empty stdout is a warning naming the lockfile", async () => {
    process.env.PATH = makeBin({ semgrep: FAKE_SEMGREP_CLEAN, docker: FAKE_DOCKER });
    process.env.EMPTY_OSV = "1";
    const { findings } = await runScanners({ dir: tmp, baselineSha: "abc", lockfiles: ["a/package-lock.json"] });
    expect(findings).toContainEqual({
      severity: "warning",
      file: "",
      rule: "scanner-failed",
      message: "osv-scanner (a/package-lock.json) exited 6 without parseable SARIF",
    });
  });

  it("gitleaks with docker missing (direct) is a scanner-missing warning", async () => {
    process.env.PATH = makeBin({ semgrep: FAKE_SEMGREP_CLEAN }); // no docker
    const { findings } = await runScanners({ dir: tmp, baselineSha: "abc" });
    expect(findings).toContainEqual({
      severity: "warning",
      file: "",
      rule: "scanner-missing",
      message: "gitleaks unavailable: docker not found",
    });
  });

  it("gitleaks timeout removes its temp report dir (no leak) and names the actual budget", async () => {
    process.env.PATH = makeBin({
      semgrep: FAKE_SEMGREP_CLEAN,
      docker: `#!/bin/sh
echo "$*" >> "$SCAN_LOG"
for a in "$@"; do case "$a" in *:/out) host="\${a%:/out}";; esac; done
if [ -n "$host" ]; then echo "$host" >> "$SCAN_LOG.reportdirs"; fi
/bin/sleep 3
exit 0
`,
    });
    const r = await runScanners({ dir: tmp, baselineSha: "abc", timeoutMs: 300 });
    expect(r.findings).toContainEqual({
      severity: "warning",
      file: "",
      rule: "scanner-failed",
      message: "gitleaks timed out after 0.3s",
    });
    const reportDir = readFileSync(`${log}.reportdirs`, "utf8").trim();
    expect(reportDir).not.toBe("");
    expect(existsSync(reportDir)).toBe(false);
  }, 30_000);

  it("uncreatable TMPDIR: gitleaks temp dir failure is a warning, never a throw", async () => {
    process.env.PATH = makeBin({ semgrep: FAKE_SEMGREP_CLEAN, docker: FAKE_DOCKER });
    process.env.TMPDIR = join(tmp, "does-not-exist");
    const r = await runScanners({ dir: tmp, baselineSha: "abc", sbom: true, outDir: tmp });
    const gl = r.findings.find((f) => f.message.startsWith("gitleaks temp dir unavailable"));
    expect(gl).toMatchObject({ severity: "warning", rule: "scanner-failed" });
  });
});

describe("per-tool timeout (M8)", () => {
  it("default budget is 10 minutes per tool invocation", () => {
    expect(TOOL_TIMEOUT_MS).toBe(600_000);
  });

  it("a tool that outlives its timeout is killed and flagged timedOut", async () => {
    const dir = mkdtempSync(join(tmpdir(), "timeout-"));
    try {
      const r = await runExec(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], dir, undefined, 300);
      expect(r.timedOut).toBe(true);
      expect(r.missing).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it("a tool that finishes in time is not flagged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "timeout-"));
    try {
      const r = await runExec(process.execPath, ["-e", "process.exit(0)"], dir, undefined, 10_000);
      expect(r.timedOut).toBe(false);
      expect(r.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a timeout becomes a scanner-failed warning, never a clean pass", () => {
    const f = fromStdout("semgrep", "semgrep", { missing: false, code: null, stdout: "", timedOut: true });
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("warning");
    expect(f[0].rule).toBe("scanner-failed");
    expect(f[0].message).toContain("timed out after 600s");
  });

  it("timeout message uses the actual timeoutMs, not the 10-minute default", () => {
    const f = fromStdout(
      "semgrep",
      "semgrep",
      { missing: false, code: null, stdout: "", timedOut: true },
      300,
    );
    expect(f).toEqual([
      { severity: "warning", file: "", rule: "scanner-failed", message: "semgrep timed out after 0.3s" },
    ]);
  });
});

describe("failed scanner invocations (F08)", () => {
  function sarifWith(o: { results: unknown[]; invocations?: unknown[] }): string {
    const run: Record<string, unknown> = { results: o.results };
    if (o.invocations !== undefined) run.invocations = o.invocations;
    return JSON.stringify({ runs: [run] });
  }

  function mkResult(ruleId = "R1"): unknown {
    return {
      ruleId,
      level: "error",
      message: { text: "bad" },
      locations: [
        { physicalLocation: { artifactLocation: { uri: "a.ts" }, region: { startLine: 1 } } },
      ],
    };
  }

  it("exit-2 SARIF with executionSuccessful:false and an error notification yields exactly one scanner-failed warning", () => {
    const stdout = sarifWith({
      results: [],
      invocations: [
        {
          executionSuccessful: false,
          toolExecutionNotifications: [{ level: "error", message: { text: "boom" } }],
        },
      ],
    });
    const result = fromStdout("semgrep", "semgrep", { missing: false, code: 2, stdout, timedOut: false });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ rule: "scanner-failed" });
  });

  it("unsuccessful run WITH results keeps the findings and appends the warning", () => {
    const stdout = sarifWith({
      results: [mkResult()],
      invocations: [{ executionSuccessful: false }],
    });
    const findings = fromStdout("semgrep", "semgrep", { missing: false, code: 2, stdout, timedOut: false });
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({ rule: "R1" });
    expect(findings[findings.length - 1]).toMatchObject({
      rule: "scanner-failed",
      message: "semgrep reported an unsuccessful run",
    });
  });

  it("exit-1 with clean successful SARIF stays quiet (findings codes keep meaning)", () => {
    const stdout = sarifWith({ results: [mkResult()] });
    const findings = fromStdout("semgrep", "semgrep", { missing: false, code: 1, stdout, timedOut: false });
    expect(findings).toHaveLength(1);
    expect(findings.some((f) => f.rule === "scanner-failed")).toBe(false);
  });

  it("trivy exit-1 with parseable SARIF warns (trivy findings exit is 0)", () => {
    const stdout = sarifWith({ results: [mkResult()] });
    const findings = fromStdout("docker", "trivy", { missing: false, code: 1, stdout, timedOut: false });
    expect(findings).toHaveLength(2);
    expect(findings[findings.length - 1]).toMatchObject({
      rule: "scanner-failed",
      message: "trivy reported an unsuccessful run",
    });
  });

  it("fatal exit without invocation info still warns", () => {
    const stdout = sarifWith({ results: [mkResult()] });
    const findings = fromStdout("semgrep", "semgrep", { missing: false, code: 2, stdout, timedOut: false });
    expect(findings).toHaveLength(2);
    expect(findings[findings.length - 1]).toMatchObject({ rule: "scanner-failed" });
  });
});
