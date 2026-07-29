/**
 * Locates the `stella-serve` binary the sidecar transport should boot, and
 * checks it against the version pinned in sidecar.config.json.
 *
 * ## Why this is `stella-serve` and not `stella serve` (oxagen #1132)
 *
 * The previous revision looked for a `stella` binary and probed it with
 * `stella serve --help`. There is no such subcommand and there never was:
 * upstream, `stella-serve` is a **separate crate with its own binary**, and
 * `stella-cli` does not link it (stella's `stella-serve/README.md` says so
 * explicitly — "a change here never reaches a `stella` user"). So the old
 * capability probe could only ever fail, which is the mechanical reason
 * #1132's live round trip had never run: every environment, including one
 * with a perfectly good serve binary installed, took the skip branch.
 *
 * Resolution order:
 *   1. `STELLA_SERVE_BIN` — absolute path to a `stella-serve` binary, highest
 *      precedence (mirrors stella's own convention of env over discovery).
 *   2. `STELLA_BIN` — accepted for continuity with the previous revision's
 *      variable name, so an existing environment keeps working.
 *   3. `stella-serve` on PATH.
 *
 * If none resolves, callers should skip rather than fail — see
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
  /** The release whose wire contract wire-types.ts has been verified against. */
  stellaVersion: string;
  /** Highest-precedence env var naming the serve binary. */
  binaryEnvVar: string;
  /** Legacy env var, still honoured. */
  legacyBinaryEnvVar: string;
  /** Command name looked up on PATH when no env var is set. */
  binaryName: string;
  readinessTimeoutMs: number;
}

export function readSidecarConfig(): SidecarConfig {
  const raw = readFileSync(join(here, "..", "sidecar.config.json"), "utf8");
  return JSON.parse(raw) as SidecarConfig;
}

export interface StellaBinaryResolution {
  /** Absolute (or PATH-relative) path/command to invoke. */
  readonly path: string;
  /** `stella-serve --version` stdout, trimmed, or undefined if unreportable. */
  readonly reportedVersion?: string;
  /** True iff reportedVersion exactly matches the pin. */
  readonly matchesPin: boolean;
}

/**
 * Resolves a runnable `stella-serve` binary. Returns `undefined` if no
 * candidate can be executed at all (not installed in this environment) — this
 * is the SKIP signal callers must gate on, per oxagen #1081: absence of the
 * Stella binary must never fail the suite hard.
 *
 * A binary that runs but cannot report a version resolves successfully with
 * `reportedVersion: undefined`. Releases before stella 0.6.2 had no
 * `--version` on this binary at all, and refusing to test them would make the
 * gate depend on the very upgrade it is meant to verify.
 */
export async function resolveStellaBinary(
  config: SidecarConfig = readSidecarConfig(),
): Promise<StellaBinaryResolution | undefined> {
  for (const candidate of candidatePaths(config)) {
    // An env var pointing at a path that does not exist is a misconfiguration
    // worth skipping past rather than a reason to abandon resolution.
    if (candidate.mustExist && !existsSync(candidate.path)) continue;
    if (!(await isRunnable(candidate.path))) continue;
    const reportedVersion = await reportVersion(candidate.path);
    return {
      path: candidate.path,
      reportedVersion,
      matchesPin: reportedVersion === config.stellaVersion,
    };
  }
  return undefined;
}

function candidatePaths(
  config: SidecarConfig,
): { path: string; mustExist: boolean }[] {
  const candidates: { path: string; mustExist: boolean }[] = [];
  for (const envVar of [config.binaryEnvVar, config.legacyBinaryEnvVar]) {
    const value = process.env[envVar];
    if (value) candidates.push({ path: value, mustExist: true });
  }
  candidates.push({ path: config.binaryName, mustExist: false });
  return candidates;
}

/**
 * Whether this path is the serve binary at all.
 *
 * `--help` is the probe because it is the one invocation that is free of side
 * effects, exits 0, and is answered only by a binary that understands this
 * argument vocabulary. Booting the server to find out would bind a port; using
 * `--version` would conflate "not the right program" with "an older build of
 * the right program", which is exactly the distinction the caller needs.
 *
 * Older builds predate `--help` and exit non-zero with "unknown argument" on
 * stderr. That output still identifies the program, so we accept it — the
 * alternative is refusing to test any release older than the one that added
 * the flag.
 */
async function isRunnable(path: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(path, ["--help"]);
    return stdout.includes("stella-serve");
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? "";
    return stderr.includes("stella-serve");
  }
}

async function reportVersion(path: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(path, ["--version"]);
    return parseVersion(stdout.trim());
  } catch {
    // Pre-0.6.2 builds reject `--version`; the binary is still usable.
    return undefined;
  }
}

/** `stella-serve --version` prints e.g. "stella-serve 0.6.2"; take the semver. */
function parseVersion(versionOutput: string): string | undefined {
  const match = /(\d+\.\d+\.\d+)/.exec(versionOutput);
  return match?.[1];
}
