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
 * `--verify` runs the published tarball with npx and checks that
 * `oxagen --version` prints it. It tries again before it fails, in case the
 * tarball takes a moment to reach npm's servers.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { argv, exit } from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { isEntrypoint } from "./lib/is-entrypoint.mjs";
import {
  type PublishOutcome,
  publishCliToNpm,
  tarballUrl,
} from "./lib/npm-cli";

const ROOT = resolve(import.meta.dirname, "../..");
export const VERIFY_TRIES = 6;
const VERIFY_WAIT_MS = 20_000;

/** What `main` needs from the outside world. The tests replace each one. */
export interface PublishCliDeps {
  /** The version apps/cli/package.json carries. */
  cliVersion: () => string;
  publish: (version: string) => Promise<PublishOutcome>;
  /** What `npx <spec> --version` prints. Throws when npx fails. */
  npxVersion: (spec: string) => string;
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
  publish: (version) => publishCliToNpm(version),
  // From outside the checkout, so npx fetches the published package rather
  // than finding the workspace's own @oxagen/cli.
  npxVersion: (spec) =>
    execFileSync("npx", ["--yes", spec, "--version"], {
      cwd: tmpdir(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim(),
  sleep: (ms) => sleep(ms),
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

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

  let outcome: PublishOutcome;
  try {
    outcome = await deps.publish(version);
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
  if (outcome === "skipped" || !verify) return 0;

  // The tarball URL, not `@oxagen/cli@<version>`: npm serves a new tarball at
  // once, but its package list can trail a publish by several minutes, and
  // npx resolves a version through that list. The first publish on
  // 2026-10-02 waited four minutes for it.
  const spec = tarballUrl(version);
  for (let attempt = 1; attempt <= VERIFY_TRIES; attempt++) {
    let printed = "";
    try {
      printed = deps.npxVersion(spec);
    } catch (err) {
      printed = err instanceof Error ? (err.message.split("\n")[0] ?? "") : "";
    }
    if (printed === version) {
      deps.log(`npx ${spec} --version prints ${version}`);
      return 0;
    }
    deps.log(
      `npx ${spec} --version printed "${printed}" (try ${attempt} of ${VERIFY_TRIES})`,
    );
    if (attempt < VERIFY_TRIES) await deps.sleep(VERIFY_WAIT_MS);
  }
  deps.error(`::error::npx ${spec} --version never printed ${version}`);
  return 1;
}

if (isEntrypoint(import.meta.url)) exit(await main(argv.slice(2)));
