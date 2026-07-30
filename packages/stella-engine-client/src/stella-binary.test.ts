/**
 * Unit coverage for the stella-serve binary resolver, with no dependency on a
 * real stella install. It drives every resolution branch — env var missing, an
 * env path that does not exist, an existing-but-unrunnable candidate, the
 * legacy env var, the PATH fallback, a runnable binary whose reported version
 * does / does not match the pin, and a pre-0.6.2 build that has no `--version`
 * at all — using throwaway shell-script fixtures under the OS temp dir.
 *
 * The fixtures impersonate `stella-serve` by printing its own name, because
 * that is exactly how the resolver identifies the program: `node` is not a
 * valid stand-in here, which is the point. The previous revision used
 * `process.execPath`, and would have accepted any runnable file on the system
 * as a Stella engine server.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { readSidecarConfig, resolveStellaBinary } from "./stella-binary.js";
import type { SidecarConfig } from "./stella-binary.js";

const ENV_VAR = "STELLA_SERVE_BIN_UNDER_TEST";
const LEGACY_ENV_VAR = "STELLA_BIN_UNDER_TEST";
const cleanups: Array<() => void> = [];

function baseConfig(overrides: Partial<SidecarConfig> = {}): SidecarConfig {
  return {
    stellaVersion: "0.0.0-nomatch",
    binaryEnvVar: ENV_VAR,
    legacyBinaryEnvVar: LEGACY_ENV_VAR,
    // A command name that cannot resolve on PATH, so tests that mean to
    // exercise the env vars are not rescued by a real install.
    binaryName: "stella-serve-not-on-path-xyz",
    readinessTimeoutMs: 1000,
    ...overrides,
  };
}

function tempFile(name: string, contents: string, mode?: number): string {
  const dir = mkdtempSync(join(tmpdir(), "stella-bin-"));
  const p = join(dir, name);
  writeFileSync(p, contents);
  if (mode !== undefined) chmodSync(p, mode);
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return p;
}

/** A fixture that answers `--help` and `--version` like stella-serve 0.6.2+. */
function fakeServe(version: string): string {
  return tempFile(
    "stella-serve",
    `#!/bin/sh
case "$1" in
  --help)    echo "stella-serve — headless Stella engine server"; exit 0 ;;
  --version) echo "stella-serve ${version}"; exit 0 ;;
esac
exit 1
`,
    0o755,
  );
}

/** A fixture behaving like a pre-0.6.2 build: no --help, no --version. */
function fakeOldServe(): string {
  return tempFile(
    "stella-serve",
    `#!/bin/sh
echo "stella-serve: unknown argument \\\`$1\\\` (expected none, or \\\`healthcheck\\\`)" >&2
exit 1
`,
    0o755,
  );
}

afterEach(() => {
  delete process.env[ENV_VAR];
  delete process.env[LEGACY_ENV_VAR];
  while (cleanups.length) cleanups.pop()?.();
});

describe("readSidecarConfig", () => {
  test("parses the committed sidecar.config.json", () => {
    const cfg = readSidecarConfig();
    expect(cfg.binaryEnvVar).toBe("STELLA_SERVE_BIN");
    expect(cfg.legacyBinaryEnvVar).toBe("STELLA_BIN");
    expect(cfg.binaryName).toBe("stella-serve");
    expect(cfg.stellaVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("resolveStellaBinary", () => {
  test("returns undefined when nothing resolves", async () => {
    await expect(resolveStellaBinary(baseConfig())).resolves.toBeUndefined();
  });

  test("returns undefined when the env-pinned path does not exist", async () => {
    process.env[ENV_VAR] = join(tmpdir(), "definitely-not-here-stella-xyz");
    await expect(resolveStellaBinary(baseConfig())).resolves.toBeUndefined();
  });

  test("returns undefined when the candidate exists but is not stella-serve", async () => {
    // A plain, non-executable text file: existsSync passes, execFile throws,
    // and nothing on either stream names the program.
    process.env[ENV_VAR] = tempFile("not-a-binary", "just text\n", 0o644);
    await expect(resolveStellaBinary(baseConfig())).resolves.toBeUndefined();
  });

  test("resolves a runnable binary and reports matchesPin=false on mismatch", async () => {
    const path = fakeServe("0.6.2");
    process.env[ENV_VAR] = path;
    const res = await resolveStellaBinary(baseConfig());
    expect(res?.path).toBe(path);
    expect(res?.reportedVersion).toBe("0.6.2");
    expect(res?.matchesPin).toBe(false);
  });

  test("reports matchesPin=true when the pin equals the reported version", async () => {
    process.env[ENV_VAR] = fakeServe("0.6.2");
    const pinned = await resolveStellaBinary(
      baseConfig({ stellaVersion: "0.6.2" }),
    );
    expect(pinned?.matchesPin).toBe(true);
  });

  test("the primary env var wins over the legacy one", async () => {
    const primary = fakeServe("0.6.2");
    process.env[ENV_VAR] = primary;
    process.env[LEGACY_ENV_VAR] = fakeServe("0.5.0");
    const res = await resolveStellaBinary(baseConfig());
    expect(res?.path).toBe(primary);
    expect(res?.reportedVersion).toBe("0.6.2");
  });

  test("the legacy env var still resolves on its own", async () => {
    const legacy = fakeServe("0.5.0");
    process.env[LEGACY_ENV_VAR] = legacy;
    const res = await resolveStellaBinary(baseConfig());
    expect(res?.path).toBe(legacy);
  });

  test("falls back to the configured command name on PATH", async () => {
    // Point `binaryName` at an absolute fixture path: resolution must reach the
    // third candidate at all, which the previous revision could not do once an
    // env var was set.
    const onPath = fakeServe("0.6.2");
    const res = await resolveStellaBinary(baseConfig({ binaryName: onPath }));
    expect(res?.path).toBe(onPath);
  });

  test("a pre-0.6.2 build resolves with no reported version", async () => {
    // It identifies itself on stderr while exiting non-zero, so it is usable —
    // refusing it would make the gate depend on the upgrade it verifies.
    process.env[ENV_VAR] = fakeOldServe();
    const res = await resolveStellaBinary(baseConfig());
    expect(res).toBeDefined();
    expect(res?.reportedVersion).toBeUndefined();
    expect(res?.matchesPin).toBe(false);
  });
});
