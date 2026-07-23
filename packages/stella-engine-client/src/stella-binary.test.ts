/**
 * Unit coverage for the stella binary resolver, with no dependency on a real
 * stella install. It drives every resolution branch — env var missing, env
 * path that does not exist, an existing-but-unrunnable candidate, a runnable
 * candidate whose reported version does / does not match the pin, and the
 * non-semver `--version` fallback — using throwaway fixtures under the OS
 * temp dir and the current node binary as a stand-in "runnable stella".
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { readSidecarConfig, resolveStellaBinary } from "./stella-binary.js";
import type { SidecarConfig } from "./stella-binary.js";

const ENV_VAR = "STELLA_BIN_UNDER_TEST";
const cleanups: Array<() => void> = [];

function baseConfig(overrides: Partial<SidecarConfig> = {}): SidecarConfig {
  return {
    stellaVersion: "0.0.0-nomatch",
    binaryEnvVar: ENV_VAR,
    servePortEnvVar: "STELLA_SERVE_PORT_UNDER_TEST",
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

afterEach(() => {
  delete process.env[ENV_VAR];
  while (cleanups.length) cleanups.pop()?.();
});

describe("readSidecarConfig", () => {
  test("parses the committed sidecar.config.json", () => {
    const cfg = readSidecarConfig();
    expect(cfg.binaryEnvVar).toBe("STELLA_BIN");
    expect(cfg.stellaVersion).toMatch(/\d+\.\d+\.\d+/);
  });
});

describe("resolveStellaBinary", () => {
  test("returns undefined when the env-pinned path does not exist", async () => {
    process.env[ENV_VAR] = join(tmpdir(), "definitely-not-here-stella-xyz");
    await expect(resolveStellaBinary(baseConfig())).resolves.toBeUndefined();
  });

  test("returns undefined when the candidate exists but cannot be run", async () => {
    // A plain, non-executable text file: existsSync passes, execFile throws.
    process.env[ENV_VAR] = tempFile("not-a-binary", "just text\n", 0o644);
    await expect(resolveStellaBinary(baseConfig())).resolves.toBeUndefined();
  });

  test("resolves a runnable binary and reports matchesPin=false on mismatch", async () => {
    process.env[ENV_VAR] = process.execPath; // node --version prints vX.Y.Z
    const res = await resolveStellaBinary(baseConfig());
    expect(res).toBeDefined();
    expect(res?.path).toBe(process.execPath);
    expect(res?.reportedVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(res?.matchesPin).toBe(false);
  });

  test("reports matchesPin=true when the pin equals the reported version", async () => {
    process.env[ENV_VAR] = process.execPath;
    const first = await resolveStellaBinary(baseConfig());
    const pinned = await resolveStellaBinary(
      baseConfig({ stellaVersion: first?.reportedVersion }),
    );
    expect(pinned?.matchesPin).toBe(true);
  });

  test("falls back to the raw output when --version has no semver", async () => {
    const script = tempFile(
      "fake-stella.sh",
      "#!/bin/sh\necho custombuild\n",
      0o755,
    );
    process.env[ENV_VAR] = script;
    const res = await resolveStellaBinary(baseConfig());
    expect(res?.reportedVersion).toBe("custombuild");
    expect(res?.matchesPin).toBe(false);
  });
});
