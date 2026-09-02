// Tests for buildEnvRefIndex paths that require mocking execFileSync:
//   - ENOENT fallback (walkRefIndex Node.js walker)
//   - rg exits non-zero but provides stdout
//   - rg crashes with an unrecognised error code
//
// Kept in a separate file so the top-level vi.mock does not affect the
// real-rg tests in secrets-usage.test.ts.

import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted before imports, so this mock takes effect before
// secrets-usage.ts loads node:child_process. We return an auto-mock so that
// vi.mocked(execFileSync) is available for per-test configuration.
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import { buildEnvRefIndex } from "./secrets-usage";

const mockExecFileSync = vi.mocked(execFileSync);

// Helper: throw an ENOENT error (rg not installed)
function throwENOENT(): never {
  const err = new Error("spawn rg ENOENT") as Error & { code: string };
  err.code = "ENOENT";
  throw err;
}

// Helper: throw an error with stdout (rg exited non-zero but matched something)
function throwWithStdout(stdout: string): never {
  const err = new Error("rg exit 1") as Error & {
    status: number;
    stdout: string;
    code?: string;
  };
  err.status = 1;
  err.stdout = stdout;
  throw err;
}

// Helper: throw an unrecognised error (no stdout, no ENOENT)
function throwUnknown(): never {
  const err = new Error("rg EPERM") as Error & { code: string };
  err.code = "EPERM";
  throw err;
}

// ---- Shared tmp tree used by most ENOENT-fallback tests ----
let root = "";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "env-mgr-mock-"));

  // apps/api — references via all three env-var syntaxes
  mkdirSync(join(root, "apps", "api", "src"), { recursive: true });
  writeFileSync(
    join(root, "apps", "api", "src", "index.ts"),
    [
      "const a = process.env.API_KEY;",
      'const b = process.env["DB_URL"];',
      "const c = env.REDIS_URL;",
    ].join("\n"),
  );

  // packages/billing
  mkdirSync(join(root, "packages", "billing", "src"), { recursive: true });
  writeFileSync(
    join(root, "packages", "billing", "src", "index.ts"),
    "const s = process.env.STRIPE_SECRET_KEY;\n",
  );

  // tools/ — should be walked but files there get no label (not apps/ or packages/)
  mkdirSync(join(root, "tools", "env-manager", "src"), { recursive: true });
  writeFileSync(
    join(root, "tools", "env-manager", "src", "noop.ts"),
    "const x = process.env.TOOL_ONLY_VAR;\n",
  );

  // Hidden directory — skipped by the walker
  mkdirSync(join(root, "apps", ".hidden"), { recursive: true });
  writeFileSync(
    join(root, "apps", ".hidden", "secret.ts"),
    "const h = process.env.HIDDEN_VAR;\n",
  );

  // node_modules / dist / build / coverage dirs — all skipped
  for (const ignored of ["node_modules", "dist", "build", "coverage"]) {
    mkdirSync(join(root, "apps", "api", ignored), { recursive: true });
    writeFileSync(
      join(root, "apps", "api", ignored, "file.ts"),
      "const ig = process.env.SHOULD_SKIP_VAR;\n",
    );
  }
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("buildEnvRefIndex — ENOENT fallback (walkRefIndex)", () => {
  it("walks apps/ and packages/ and attributes env refs when rg is absent", () => {
    mockExecFileSync.mockImplementationOnce(throwENOENT);

    const index = buildEnvRefIndex(root);

    // process.env.API_KEY → app:api
    expect(index.get("API_KEY")).toEqual(new Set(["app:api"]));
    // process.env["DB_URL"] → app:api
    expect(index.get("DB_URL")).toEqual(new Set(["app:api"]));
    // env.REDIS_URL → app:api
    expect(index.get("REDIS_URL")).toEqual(new Set(["app:api"]));
    // STRIPE_SECRET_KEY → pkg:billing
    expect(index.get("STRIPE_SECRET_KEY")).toEqual(new Set(["pkg:billing"]));
  });

  it("does not label files under tools/ (they are walked but get no app:/pkg: label)", () => {
    mockExecFileSync.mockImplementationOnce(throwENOENT);
    const index = buildEnvRefIndex(root);
    expect(index.has("TOOL_ONLY_VAR")).toBe(false);
  });

  it("skips hidden directories (names starting with '.')", () => {
    mockExecFileSync.mockImplementationOnce(throwENOENT);
    const index = buildEnvRefIndex(root);
    expect(index.has("HIDDEN_VAR")).toBe(false);
  });

  it("skips node_modules, dist, build, and coverage directories", () => {
    mockExecFileSync.mockImplementationOnce(throwENOENT);
    const index = buildEnvRefIndex(root);
    expect(index.has("SHOULD_SKIP_VAR")).toBe(false);
  });

  it("returns empty index when the root has no apps/ or packages/ directories", () => {
    mockExecFileSync.mockImplementationOnce(throwENOENT);
    const emptyRoot = mkdtempSync(join(tmpdir(), "env-mgr-empty-"));
    let index: Map<string, Set<string>>;
    try {
      index = buildEnvRefIndex(emptyRoot);
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
    expect(index.size).toBe(0);
  });
});

describe("buildEnvRefIndex — rg exits non-zero with stdout", () => {
  it("uses rg stdout output even when rg exits with a non-zero status", () => {
    mockExecFileSync.mockImplementationOnce(() =>
      throwWithStdout("apps/api/src/index.ts:process.env.RG_FOUND_VAR\n"),
    );

    const index = buildEnvRefIndex(root);

    expect(index.get("RG_FOUND_VAR")).toEqual(new Set(["app:api"]));
  });

  it("ignores rg output lines that do not contain a colon separator", () => {
    mockExecFileSync.mockImplementationOnce(() =>
      throwWithStdout("no-colon-line\n"),
    );
    const index = buildEnvRefIndex(root);
    // No crash and no spurious entries
    expect(index.size).toBe(0);
  });

  it("ignores rg output lines from paths not under apps/ or packages/", () => {
    mockExecFileSync.mockImplementationOnce(() =>
      throwWithStdout("tools/env-manager/noop.ts:process.env.TOOLS_VAR\n"),
    );
    const index = buildEnvRefIndex(root);
    expect(index.has("TOOLS_VAR")).toBe(false);
  });
});

describe("buildEnvRefIndex — unrecognised rg error (no stdout, no ENOENT)", () => {
  it("returns an empty index and does not throw", () => {
    mockExecFileSync.mockImplementationOnce(throwUnknown);
    const index = buildEnvRefIndex(root);
    expect(index.size).toBe(0);
  });
});

describe("buildEnvRefIndex — walkRefIndex unreadable file handling", () => {
  it("silently skips files that cannot be read", () => {
    // Only meaningful on non-root Unix where chmod 000 actually blocks reads
    // (root — e.g. the CI toolchain containers — reads mode-000 files anyway)
    if (process.platform === "win32") return;
    if (typeof process.getuid === "function" && process.getuid() === 0) return;

    const tmpRoot = mkdtempSync(join(tmpdir(), "env-mgr-unreadable-"));
    mkdirSync(join(tmpRoot, "apps", "myapp", "src"), { recursive: true });

    writeFileSync(
      join(tmpRoot, "apps", "myapp", "src", "readable.ts"),
      "const x = process.env.READABLE_VAR;\n",
    );
    const unreadable = join(tmpRoot, "apps", "myapp", "src", "unreadable.ts");
    writeFileSync(unreadable, "const y = process.env.UNREADABLE_VAR;\n");

    mockExecFileSync.mockImplementationOnce(throwENOENT);

    let index: Map<string, Set<string>>;
    try {
      chmodSync(unreadable, 0o000);
      index = buildEnvRefIndex(tmpRoot);
    } finally {
      chmodSync(unreadable, 0o644);
      rmSync(tmpRoot, { recursive: true, force: true });
    }

    expect(index.get("READABLE_VAR")).toEqual(new Set(["app:myapp"]));
    expect(index.has("UNREADABLE_VAR")).toBe(false);
  });
});
