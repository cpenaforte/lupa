import { describe, it, expect } from "vitest";
import {
  addedLines,
  contentText,
  hasPrivateKeyMarker,
  isPlaceholderValue,
  isSecretKeyName,
  isSecretValue,
  runL0,
  stripProvenance,
} from "../src/fastpath.js";
import { isLockfile, type FileDiff } from "../src/diff.js";

/** sensitive-path findings for a single synthetic file entry. */
function sensitive(file: string, hunks: string, extra: Partial<FileDiff> = {}) {
  return runL0([{ file, hunks, truncated: false, ...extra }]).filter((x) => x.rule === "sensitive-path");
}

describe("contentText", () => {
  it("returns content for added and unprefixed lines, stripping a trailing CR", () => {
    expect(contentText("+const a = 1;")).toBe("const a = 1;");
    expect(contentText("const a = 1;")).toBe("const a = 1;");
    expect(contentText("+const a = 1;\r")).toBe("const a = 1;");
    expect(contentText("const a = 1;\r")).toBe("const a = 1;");
  });

  it("returns undefined for context, removed, no-newline, hunk-header, and empty lines", () => {
    expect(contentText(" const a = 1;")).toBeUndefined();
    expect(contentText("-const a = 1;")).toBeUndefined();
    expect(contentText("\\ No newline at end of file")).toBeUndefined();
    expect(contentText("@@ -1,2 +1,3 @@")).toBeUndefined();
    expect(contentText("")).toBeUndefined();
  });
});

describe("addedLines", () => {
  it("maps contentText over hunks lines, dropping context/removed/header lines", () => {
    const hunks = ["@@ -1,2 +1,3 @@", " const a = 1;", "+const b = 2;", "-gone", "+const c = 3;"].join("\n");
    expect(addedLines(hunks)).toEqual(["const b = 2;", "const c = 3;"]);
  });
});

describe("hasPrivateKeyMarker", () => {
  it("matches every supported marker variant, leading-whitespace tolerant", () => {
    for (const marker of [
      "-----BEGIN PRIVATE KEY-----",
      "-----BEGIN RSA PRIVATE KEY-----",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "-----BEGIN EC PRIVATE KEY-----",
      "-----BEGIN DSA PRIVATE KEY-----",
      "-----BEGIN ENCRYPTED PRIVATE KEY-----",
      "   -----BEGIN RSA PRIVATE KEY-----",
    ]) {
      expect(hasPrivateKeyMarker([marker])).toBe(true);
    }
  });

  it("rejects certificate-only and public-key lines and empty input", () => {
    expect(hasPrivateKeyMarker(["-----BEGIN CERTIFICATE-----"])).toBe(false);
    expect(hasPrivateKeyMarker(["-----BEGIN PUBLIC KEY-----"])).toBe(false);
    expect(hasPrivateKeyMarker([])).toBe(false);
  });
});

describe("isPlaceholderValue", () => {
  it("flags every pinned literal case-insensitively", () => {
    for (const value of [
      "changeme", "change-me", "example", "sample", "test", "testing", "xxx",
      "password", "password123", "123456", "placeholder", "none", "CHANGEME", "None",
    ]) {
      expect(isPlaceholderValue(value)).toBe(true);
    }
  });

  it("flags anchored pattern placeholders", () => {
    for (const value of [
      "EXAMPLE_NOT_A_SECRET",
      "prefix_EXAMPLE_NOT_A_SECRET_suffix",
      "AKIAIOSFODNN7EXAMPLE",
      "AKIAIOSFODNN7EXAMPLEXYZ",
      "ghp_EXAMPLE",
      "ghp_EXAMPLE123",
      "xxxx",
      "XXXX",
      "<your-key>",
      "${MY_VAR}",
      "***",
    ]) {
      expect(isPlaceholderValue(value)).toBe(true);
    }
  });

  it("treats a whole-value $VAR reference as placeholder, but not a path", () => {
    expect(isPlaceholderValue("$MY_SECRET")).toBe(true);
    expect(isPlaceholderValue("${MY_SECRET}")).toBe(true);
    expect(isPlaceholderValue("$HOME/real")).toBe(false);
  });

  it("strips one matched quote layer and trailing comments", () => {
    expect(isPlaceholderValue('"changeme"')).toBe(true);
    expect(isPlaceholderValue("'test'")).toBe(true);
    expect(isPlaceholderValue("# fill in")).toBe(true);
    expect(isPlaceholderValue(" # fill in")).toBe(true);
  });

  it("strips nothing for mismatched quotes and keeps real-shaped values real", () => {
    expect(isPlaceholderValue("\"a'")).toBe(false);
    expect(isPlaceholderValue("'a\"")).toBe(false);
    expect(isPlaceholderValue("ghp_live_abc123")).toBe(false);
    expect(isPlaceholderValue("hunter2")).toBe(false);
    expect(isPlaceholderValue("x@db.example.com")).toBe(false);
  });
});

describe("isSecretKeyName", () => {
  it("flags substring and delimited-segment secret keys case-insensitively", () => {
    for (const key of [
      "SECRET", "MY_TOKEN", "DB_PASSWORD", "PASSWD", "PRIVATE_MODE", "CREDENTIAL",
      "API_KEY", "APIKEY", "AUTH_TOKEN", "ACCESS_KEY", "SESSION_KEY",
      "db_pass", "smtp_pass", "JWT_SIGNING_KEY", "ENCRYPTION_KEY", "MASTER_KEY",
      "AUTHORIZATION", "auth",
    ]) {
      expect(isSecretKeyName(key)).toBe(true);
    }
  });

  it("does not flag keys with no secret substring or delimited segment", () => {
    for (const key of ["COMPASS", "BYPASS", "PORT", "DEBUG", "HOST", "USER", "PATH"]) {
      expect(isSecretKeyName(key)).toBe(false);
    }
  });
});

describe("isSecretValue", () => {
  it("is true for real-shaped values", () => {
    for (const value of ["hunter2", "k8s-sign-01", "ghp_abcdef123456", "x@db.example.com", "postgres://user:pass@db"]) {
      expect(isSecretValue(value)).toBe(true);
    }
  });

  it("is false for placeholders", () => {
    expect(isSecretValue("changeme")).toBe(false);
    expect(isSecretValue("# fill in")).toBe(false);
  });

  it("is false for numeric, boolean, and credential-less URL values", () => {
    for (const value of [
      "3600", "4096", "8", "0", "1", "-1", "1.5", "1e10", ".5",
      "true", "false", "yes", "no", "on", "off", "TRUE",
      "https://api.acme.io", "https://api.acme.io/v1", "postgres://db",
    ]) {
      expect(isSecretValue(value)).toBe(false);
    }
  });

  it("stays real for a userinfo URL (credential in the authority)", () => {
    expect(isSecretValue("https://user:pass@api.acme.io")).toBe(true);
  });
});

describe("CRLF normalization", () => {
  it("parses an assignment value with a trailing CR", () => {
    expect(isSecretValue("hunter2\r")).toBe(true);
  });

  it("treats a placeholder with a trailing CR as placeholder", () => {
    expect(isPlaceholderValue("xxx\r")).toBe(true);
  });

  it("matches a private-key marker line with a trailing CR", () => {
    expect(hasPrivateKeyMarker(["-----BEGIN OPENSSH PRIVATE KEY-----\r"])).toBe(true);
  });
});

describe("isLockfile", () => {
  it("matches known lockfile basenames in any directory", () => {
    expect(isLockfile("package-lock.json")).toBe(true);
    expect(isLockfile("apps/web/Cargo.lock")).toBe(true);
    expect(isLockfile("go.sum")).toBe(true);
  });

  it("rejects manifests and unrelated files", () => {
    expect(isLockfile("package.json")).toBe(false);
    expect(isLockfile("src/lockfile.ts")).toBe(false);
    expect(isLockfile("Cargo.toml")).toBe(false);
  });
});

describe("runL0", () => {
  it("flags pem, todos, lockfile-without-manifest (per-ecosystem)", () => {
    const noManifest = () => false;
    const f = runL0(
      [
        { file: "id_rsa", hunks: "+-----BEGIN OPENSSH PRIVATE KEY-----\n+key-material", truncated: false },
        { file: "a.ts", hunks: "// TODO fix", truncated: false },
        { file: "package-lock.json", hunks: "{}", truncated: false },
      ],
      { hasManifestFor: noManifest },
    );
    expect(f.some((x) => x.rule === "sensitive-path" && x.severity === "high")).toBe(true);
    expect(f.some((x) => x.rule === "todo-marker")).toBe(true);
    expect(f.some((x) => x.rule === "lockfile-without-manifest")).toBe(true);
    const mixed = runL0([{ file: "Cargo.lock", hunks: "", truncated: false }], {
      hasManifestFor: (l) => l === "package-lock.json",
    });
    expect(mixed.some((x) => x.rule === "lockfile-without-manifest")).toBe(true);
    const ok = runL0([{ file: "package-lock.json", hunks: "{}", truncated: false }], { hasManifestFor: () => true });
    expect(ok.some((x) => x.rule === "lockfile-without-manifest")).toBe(false);
  });

  it("binary-only input yields binary note (size-based) and large file warns", () => {
    const f = runL0([{ file: "img.png", hunks: "", truncated: false, size: 1024 }]);
    expect(f.some((x) => x.rule === "binary-note")).toBe(true);
    const big = runL0([{ file: "vid.mp4", hunks: "", truncated: false, size: 600 * 1024 }]);
    expect(big.some((x) => x.rule === "large-file" && x.severity === "warning")).toBe(true);
  });

  it("binary note fires on binary===true even with hunks present", () => {
    const f = runL0([{ file: "img.png", hunks: "Binary files differ", truncated: false, binary: true }]);
    expect(f.some((x) => x.rule === "binary-note")).toBe(true);
  });

  it("no binary note for an empty file with no size (empty hunks, size 0/undefined)", () => {
    const none = runL0([{ file: "empty.txt", hunks: "", truncated: false }]);
    expect(none.some((x) => x.rule === "binary-note")).toBe(false);
    const zero = runL0([{ file: "empty.txt", hunks: "", truncated: false, size: 0 }]);
    expect(zero.some((x) => x.rule === "binary-note")).toBe(false);
  });

  it("large-file uses size, never hunks.length", () => {
    const hugeHunks = "x".repeat(600 * 1024);
    const f = runL0([{ file: "a.ts", hunks: hugeHunks, truncated: false, size: 10 }]);
    expect(f.some((x) => x.rule === "large-file")).toBe(false);
  });

  it("no lockfile-without-manifest when the callback is omitted but no lockfile is present", () => {
    const f = runL0([{ file: "a.ts", hunks: "", truncated: false }]);
    expect(f.some((x) => x.rule === "lockfile-without-manifest")).toBe(false);
  });

  it("omitted hasManifestFor treats lockfiles as lacking a manifest (conservative)", () => {
    const f = runL0([{ file: "package-lock.json", hunks: "{}", truncated: false }]);
    expect(f.some((x) => x.rule === "lockfile-without-manifest" && x.severity === "warning")).toBe(true);
  });

  it("sensitive-path covers .env, .env.* and .pem but not unrelated names", () => {
    const f = runL0([
      { file: "config/.env", hunks: "+DB_PASS=hunter2", truncated: false },
      { file: "deploy/.env.production", hunks: "+DB_PASS=hunter2", truncated: false },
      { file: "certs/server.pem", hunks: "+-----BEGIN RSA PRIVATE KEY-----", truncated: false },
    ]);
    expect(f.filter((x) => x.rule === "sensitive-path" && x.severity === "high")).toHaveLength(3);
    const clean = runL0([{ file: "src/environment.ts", hunks: "", truncated: false }]);
    expect(clean.some((x) => x.rule === "sensitive-path")).toBe(false);
    // Hunk-less sensitive entries (mode-only change) carry no added evidence: silent.
    const hunkless = runL0([
      { file: "config/.env", hunks: "", truncated: false },
      { file: "deploy/.env.production", hunks: "", truncated: false },
      { file: "certs/server.pem", hunks: "", truncated: false },
    ]);
    expect(hunkless.some((x) => x.rule === "sensitive-path")).toBe(false);
  });

  it("env templates (.env.example, .env.sample, .env.template) are not sensitive; .env.local still is", () => {
    const templates = runL0([
      { file: "config/.env.example", hunks: "", truncated: false },
      { file: ".env.sample", hunks: "", truncated: false },
      { file: "deploy/.env.template", hunks: "", truncated: false },
    ]);
    expect(templates.some((x) => x.rule === "sensitive-path")).toBe(false);
    const local = runL0([{ file: "config/.env.local", hunks: "+DB_PASS=hunter2", truncated: false }]);
    expect(local.some((x) => x.rule === "sensitive-path" && x.severity === "high")).toBe(true);
  });

  describe("sensitive-path content gating", () => {
    it("deleted files emit nothing, including binary-note and lockfile rules", () => {
      const f = runL0([
        { file: "id_rsa", hunks: "+-----BEGIN RSA PRIVATE KEY-----", truncated: false, deleted: true },
        { file: "img.png", hunks: "", truncated: false, binary: true, deleted: true, size: 1024 },
        { file: "package-lock.json", hunks: "{}", truncated: false, deleted: true },
      ]);
      expect(f).toEqual([]);
    });

    it("certificate-only .pem content is silent (incl. explicit BEGIN PUBLIC KEY)", () => {
      expect(sensitive("certs/server.pem", "+-----BEGIN CERTIFICATE-----\n+MIIBdeadbeef")).toEqual([]);
      expect(sensitive("certs/server.pem", "+-----BEGIN PUBLIC KEY-----")).toEqual([]);
    });

    it("a newly added private key flags .pem and id_rsa at high", () => {
      expect(sensitive("certs/server.pem", "+-----BEGIN RSA PRIVATE KEY-----")[0]).toMatchObject({
        severity: "high",
        rule: "sensitive-path",
        source: "fastpath",
        confidence: 50,
      });
      expect(sensitive("id_rsa", "+-----BEGIN OPENSSH PRIVATE KEY-----")[0]?.severity).toBe("high");
    });

    it("placeholder-only .env assignments are silent", () => {
      expect(sensitive("config/.env", "+DB_PASSWORD=changeme")).toEqual([]);
      expect(sensitive("config/.env", "+API_KEY=\"example\"")).toEqual([]);
      expect(sensitive("config/.env", "+DB_PASSWORD= # fill in")).toEqual([]);
    });

    it("non-secret keys are silent even with real-looking values", () => {
      expect(sensitive("config/.env", "+PORT=3000\n+DEBUG=false")).toEqual([]);
    });

    it("secret-keyed real assignments flag .env at high", () => {
      expect(sensitive("config/.env", "+DB_PASS=hunter2")[0]?.severity).toBe("high");
      expect(sensitive("config/.env", "+JWT_SIGNING_KEY=k8s-sign-01")[0]?.severity).toBe("high");
    });

    it("numeric, boolean, and credential-less URL values stay silent under secret keys", () => {
      expect(sensitive("config/.env", "+MAX_TOKENS=4096")).toEqual([]);
      expect(sensitive("config/.env", "+MAX_TOKENS=\"4096\"")).toEqual([]);
      expect(sensitive("config/.env", "+TOKEN_TTL=3600 # seconds")).toEqual([]);
      expect(sensitive("config/.env", "+PRIVATE_MODE=false")).toEqual([]);
      expect(sensitive("config/.env", "+PASSWORD_MIN_LENGTH=8")).toEqual([]);
      expect(sensitive("config/.env", "+TOKEN_URL=https://api.acme.io")).toEqual([]);
    });

    it("a userinfo URL and an email-shaped value stay real (fail-safe)", () => {
      expect(sensitive("config/.env", "+DB_PASSWORD=https://user:pass@db.acme.io")[0]?.severity).toBe("high");
      expect(sensitive("config/.env", "+DB_PASSWORD=x@db.example.com")[0]?.severity).toBe("high");
      expect(sensitive("config/.env", "+AWS_ACCESS_KEY_ID=AKIAIOSFODNN7REALKEY")[0]?.severity).toBe("high");
    });

    it("empty, binary, and hunk-less sensitive files are silent", () => {
      expect(sensitive("config/.env", "")).toEqual([]);
      expect(sensitive("certs/server.pem", "")).toEqual([]);
      expect(sensitive("config/.env", "", { binary: true })).toEqual([]);
      expect(sensitive("config/.env", "", { size: 10 })).toEqual([]);
    });

    it("export-prefixed, quoted, and commented assignments are handled", () => {
      expect(sensitive("config/.env", "+export DB_PASS=hunter2")[0]?.severity).toBe("high");
      expect(sensitive("config/.env", "+DB_PASS='hunter2'")[0]?.severity).toBe("high");
      expect(sensitive("config/.env", "+DB_PASS=hunter2 # rotate me")[0]?.severity).toBe("high");
      expect(sensitive("config/.env", "+# DB_PASS=hunter2")).toEqual([]);
    });

    it("a PEM marker line in .env flags regardless of key names", () => {
      expect(sensitive("config/.env", "+-----BEGIN RSA PRIVATE KEY-----")[0]?.severity).toBe("high");
    });
  });

  it("todo-marker reports the line number of the marker (headerless input counts from 1)", () => {
    const f = runL0([{ file: "a.ts", hunks: "const a = 1;\n// FIXME later\n", truncated: false }]);
    const t = f.find((x) => x.rule === "todo-marker");
    expect(t?.severity).toBe("info");
    expect(t?.file).toBe("a.ts");
    expect(t?.line).toBe(2);
  });

  describe("todo-marker real new-file line numbers", () => {
    const todoLines = (hunks: string) =>
      runL0([{ file: "a.ts", hunks, truncated: false }])
        .filter((x) => x.rule === "todo-marker")
        .map((x) => x.line);

    it("uses the new-file start from the @@ header and counts added lines", () => {
      const hunks = ["@@ -10,2 +40,3 @@", " const a = 1;", "+// TODO wire this", " const b = 2;"].join("\n");
      expect(todoLines(hunks)).toEqual([41]);
    });

    it("reports a TODO on a context line at its new-file line number", () => {
      const hunks = ["@@ -5,3 +7,3 @@", " keep", " // FIXME ctx", "+added"].join("\n");
      expect(todoLines(hunks)).toEqual([8]);
    });

    it("skips TODO on removed lines entirely (no finding)", () => {
      const hunks = ["@@ -1,2 +1,1 @@", "-// TODO gone", " kept"].join("\n");
      expect(todoLines(hunks)).toEqual([]);
    });

    it("removed lines do not advance the new-file counter", () => {
      const hunks = ["@@ -1,3 +1,2 @@", "-old one", "-old two", "+// XXX new"].join("\n");
      expect(todoLines(hunks)).toEqual([1]);
    });

    it("applies per-hunk offsets across multiple hunks", () => {
      const hunks = [
        "@@ -1,2 +1,2 @@",
        " a",
        "+// TODO first",
        "@@ -50,2 +100,3 @@",
        " b",
        "+// FIXME second",
        " c",
      ].join("\n");
      expect(todoLines(hunks)).toEqual([2, 101]);
    });

    it("hunk header without explicit counts still parses", () => {
      const hunks = ["@@ -3 +9 @@", "+// TODO single"].join("\n");
      expect(todoLines(hunks)).toEqual([9]);
    });
  });
});

describe("runL0 provenance (Q04)", () => {
  it("every L0 finding carries source fastpath and confidence 50", () => {
    const f = runL0(
      [
        { file: "id_rsa", hunks: "key", truncated: false },
        { file: "big.bin", hunks: "", truncated: false, size: 600 * 1024 },
        { file: "img.png", hunks: "", truncated: false, size: 1024 },
        { file: "package-lock.json", hunks: "{}", truncated: false },
        { file: "a.ts", hunks: "// TODO fix", truncated: false },
      ],
      { hasManifestFor: () => false },
    );
    expect(f.length).toBeGreaterThan(0);
    for (const x of f) {
      expect(x.source).toBe("fastpath");
      expect(x.confidence).toBe(50);
      expect(x.evidence).toBeUndefined();
    }
  });
});

describe("stripProvenance (Q04 agent path)", () => {
  const base = { severity: "warning" as const, file: "a.ts", rule: "r", message: "m" };

  it("deletes source, confidence, and evidence, returning the finding", () => {
    const f = { ...base, source: "llm", confidence: 75, evidence: { analyzer: "llm" } };
    expect(stripProvenance(f)).toBe(f);
    expect(f).toEqual(base);
  });

  it("is a no-op when no provenance is present", () => {
    const f = { ...base };
    expect(stripProvenance(f)).toBe(f);
    expect(f).toEqual(base);
  });

  it("strips partial provenance (source-only, confidence-only, evidence-only)", () => {
    expect(stripProvenance({ ...base, source: "llm" })).toEqual(base);
    expect(stripProvenance({ ...base, confidence: 50 })).toEqual(base);
    expect(stripProvenance({ ...base, evidence: { snippet: "x" } })).toEqual(base);
  });

  it("keeps every other field (line, suggestion) intact", () => {
    const f = { ...base, line: 3, suggestion: "s", source: "llm", confidence: 0 };
    expect(stripProvenance(f)).toEqual({ ...base, line: 3, suggestion: "s" });
  });
});
