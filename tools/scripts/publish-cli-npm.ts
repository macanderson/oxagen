#!/usr/bin/env tsx
/**
 * publish-cli-npm.ts: publish the CLI this checkout carries to npm (ADR-253).
 *
 *   tsx tools/scripts/publish-cli-npm.ts <version> [--verify]
 *
 * npm.yml runs it once `desktop-build-version.ts plan` has named the version,
 * and, for a build of main, once `stamp` has written that version into every
 * manifest. The CLI's own package.json must already carry `<version>`,
 * because the bundle reads its version from there.
 *
 * A missing NPM_TOKEN fails the run. `release.ts` skips the publish instead,
 * because a laptop may have no token, but in CI a missing token means the
 * secret is gone and npm has stopped following main.
 *
 * `--verify` publishes under the `candidate` tag, runs the published tarball
 * with npx until `oxagen --version` prints the version, and only then moves
 * `latest` to it. npm can take minutes to serve a new tarball, so the check
 * keeps trying for at least 10 minutes. If it never passes, `latest` stays
 * where it was and the run fails (#5203).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { argv, exit } from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { isEntrypoint } from "./lib/is-entrypoint.mjs";
import {
  type CliCheck,
  type PublishOutcome,
  publishCliToNpm,
  tarballUrl,
} from "./lib/npm-cli";

const ROOT = resolve(import.meta.dirname, "../..");

/**
 * The check keeps trying for at least this long. On 2026-10-02 npm answered
 * 404 for a new tarball for about 5½ minutes after the publish (#5203).
 */
export const VERIFY_WINDOW_MS = 10 * 60_000;

/** One npx run may take this long before it counts as a failed try. */
const NPX_TIMEOUT_MS = 2 * 60_000;

/**
 * The pause after try `attempt`: 20 seconds, then 10 seconds longer after each
 * try, up to a minute.
 */
export function verifyPause(attempt: number): number {
  return Math.min(20_000 + (attempt - 1) * 10_000, 60_000);
}

/** A wait as `45s` or `5m 40s`. */
export function formatWait(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/**
 * The line of a failed npx run that says why, such as npm's
 * `npm error 404 Not Found - GET <url>`. The error's first line only repeats
 * the command, so the reason comes from what npx wrote to stderr.
 */
export function npxFailure(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const stderr = (err as { stderr?: unknown }).stderr;
  const text =
    typeof stderr === "string"
      ? stderr
      : err.message.split("\n").slice(1).join("\n");
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const reason = lines.find((line) =>
    /^npm (?:error|ERR!) (?!code\b)(?!A complete log)/.test(line),
  );
  return reason ?? lines.at(-1) ?? err.message.split("\n")[0] ?? "";
}

/** What `main` needs from the outside world. The tests replace each one. */
export interface PublishCliDeps {
  /** The version apps/cli/package.json carries. */
  cliVersion: () => string;
  /** Publishes `version`. With `check`, `latest` waits for the check. */
  publish: (version: string, check?: CliCheck) => Promise<PublishOutcome>;
  /** What `npx <spec> --version` prints. Throws when npx fails. */
  npxVersion: (spec: string) => string;
  /** The time in milliseconds. */
  now: () => number;
  sleep: (ms: number) => Promise<unknown>;
  log: (line: string) => void;
  error: (line: string) => void;
}

const defaultDeps: PublishCliDeps = {
  cliVersion: () =>
    (
      JSON.parse(
        readFileSync(resolve(ROOT, "apps/cli/package.json"), "utf8"),
      ) as { version: string }
    ).version,
  publish: (version, check) => publishCliToNpm(version, check ? { check } : {}),
  // From outside the checkout, so npx fetches the published package rather
  // than finding the workspace's own @oxagen/cli.
  npxVersion: (spec) =>
    execFileSync("npx", ["--yes", spec, "--version"], {
      cwd: tmpdir(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: NPX_TIMEOUT_MS,
    }).trim(),
  now: () => Date.now(),
  sleep: (ms) => sleep(ms),
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

/**
 * Runs the published tarball with npx until `oxagen --version` prints
 * `version`, and answers whether it ever did. It keeps trying for at least
 * VERIFY_WINDOW_MS, with a longer pause after each try, and logs how long it
 * waited.
 *
 * It runs the tarball URL, not `@oxagen/cli@<version>`, because npx finds a
 * version through npm's package list, and that list can trail a publish by
 * several minutes. The tarball URL can trail it too: on 2026-10-02 it
 * answered 404 for about 5½ minutes (#5203).
 */
export async function checkCli(
  version: string,
  deps: PublishCliDeps,
): Promise<boolean> {
  const spec = tarballUrl(version);
  const start = deps.now();
  for (let attempt = 1; ; attempt++) {
    let printed: string;
    try {
      printed = deps.npxVersion(spec);
    } catch (err) {
      printed = npxFailure(err);
    }
    const waited = deps.now() - start;
    if (printed === version) {
      deps.log(
        `npx ${spec} --version printed ${version} after ${formatWait(waited)} (try ${attempt})`,
      );
      return true;
    }
    deps.log(
      `npx ${spec} --version printed "${printed}" after ${formatWait(waited)} (try ${attempt})`,
    );
    if (waited >= VERIFY_WINDOW_MS) {
      deps.log(
        `npx ${spec} --version never printed ${version}. It waited ${formatWait(waited)} over ${attempt} tries.`,
      );
      return false;
    }
    await deps.sleep(Math.min(verifyPause(attempt), VERIFY_WINDOW_MS - waited));
  }
}

/** Runs the publish and answers the process exit code. */
export async function main(
  args: string[],
  deps: PublishCliDeps = defaultDeps,
): Promise<number> {
  const version = args.find((a) => !a.startsWith("--"));
  const verify = args.includes("--verify");
  if (version === undefined) {
    deps.error("usage: publish-cli-npm.ts <version> [--verify]");
    return 2;
  }

  const cliVersion = deps.cliVersion();
  if (cliVersion !== version) {
    deps.error(
      `apps/cli/package.json says ${cliVersion}, not ${version}. Run \`desktop-build-version.ts stamp ${version}\` first.`,
    );
    return 1;
  }

  // With --verify, `latest` moves only once the published CLI runs.
  const check: CliCheck | undefined = verify
    ? (v) => checkCli(v, deps)
    : undefined;
  let outcome: PublishOutcome;
  try {
    outcome = await deps.publish(version, check);
  } catch (err) {
    deps.error(`::error::${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (outcome === "no-token") {
    deps.error(
      "::error::NPM_TOKEN is not set, so the CLI cannot be published. Save a granular npm token that can write @oxagen/cli as the NPM_TOKEN repository secret. packages/config/src/ci-registry.ts says how.",
    );
    return 1;
  }
  return 0;
}

if (isEntrypoint(import.meta.url)) exit(await main(argv.slice(2)));
