/**
 * Locates the `stella` binary the sidecar transport should boot, and checks
 * it against the version pinned in sidecar.config.json.
 *
 * Resolution order (documented for anyone wiring this into a new
 * environment):
 *   1. `STELLA_BIN` env var — absolute path to a stella binary, highest
 *      precedence (mirrors stella's own credential-chain convention of env
 *      over auto-discovery).
 *   2. `stella` on PATH.
 *
 * If neither resolves, callers should skip rather than fail — see
 * `resolveStellaBinary`'s doc comment and stella-serve.smoke.test.ts.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));

export interface SidecarConfig {
  stellaVersion: string;
  binaryEnvVar: string;
  servePortEnvVar: string;
  readinessTimeoutMs: number;
}

export function readSidecarConfig(): SidecarConfig {
  const raw = readFileSync(join(here, "..", "sidecar.config.json"), "utf8");
  return JSON.parse(raw) as SidecarConfig;
}

export interface StellaBinaryResolution {
  /** Absolute (or PATH-relative) path/command to invoke. */
  readonly path: string;
  /** `stella --version` stdout, trimmed, or undefined if it could not be run. */
  readonly reportedVersion?: string;
  /** True iff reportedVersion exactly matches the pin. */
  readonly matchesPin: boolean;
}

/**
 * Resolves a runnable `stella` binary using the env var named by
 * sidecar.config.json's `binaryEnvVar`, falling back to PATH. Returns
 * `undefined` if no candidate can be executed at all (not installed in this
 * environment) — this is the SKIP signal callers must gate on, per oxagen
 * #1081: absence of the pinned Stella binary must never fail the suite hard.
 */
export async function resolveStellaBinary(
  config: SidecarConfig = readSidecarConfig(),
): Promise<StellaBinaryResolution | undefined> {
  const envPath = process.env[config.binaryEnvVar];
  const candidates = envPath ? [envPath] : ["stella"];

  for (const candidate of candidates) {
    if (envPath && !existsSync(envPath) && envPath !== "stella") {
      continue;
    }
    try {
      const { stdout } = await execFileAsync(candidate, ["--version"]);
      const reportedVersion = parseVersion(stdout.trim());
      return {
        path: candidate,
        reportedVersion,
        matchesPin: reportedVersion === config.stellaVersion,
      };
    } catch {
      // ENOENT (not installed) or non-zero exit — try the next candidate,
      // and ultimately report "not available" rather than throwing.
      continue;
    }
  }
  return undefined;
}

/** `stella --version` prints e.g. "stella 0.4.47"; extract the bare semver. */
function parseVersion(versionOutput: string): string {
  const match = /(\d+\.\d+\.\d+)/.exec(versionOutput);
  return match?.[1] ?? versionOutput;
}
