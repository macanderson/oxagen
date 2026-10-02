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
 * `--verify` runs the published version with npx and checks that
 * `oxagen --version` prints it. The registry can take a minute to serve a new
 * version, so it tries again before it fails.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { argv, env, exit } from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { CLI_PACKAGE, publishCliToNpm } from "./lib/npm-cli";

const ROOT = resolve(import.meta.dirname, "../..");
const VERIFY_TRIES = 6;
const VERIFY_WAIT_MS = 20_000;

async function main(args: string[]): Promise<number> {
  const version = args.find((a) => !a.startsWith("--"));
  const verify = args.includes("--verify");
  if (version === undefined) {
    console.error("usage: publish-cli-npm.ts <version> [--verify]");
    return 2;
  }

  const cliVersion = (
    JSON.parse(
      readFileSync(resolve(ROOT, "apps/cli/package.json"), "utf8"),
    ) as { version: string }
  ).version;
  if (cliVersion !== version) {
    console.error(
      `apps/cli/package.json says ${cliVersion}, not ${version}. Run \`desktop-build-version.ts stamp ${version}\` first.`,
    );
    return 1;
  }

  if (!env.NPM_TOKEN) {
    console.error(
      "::error::NPM_TOKEN is not set, so the CLI cannot be published. Save a granular npm token that can write @oxagen/cli as the NPM_TOKEN repository secret. packages/config/src/ci-registry.ts says how.",
    );
    return 1;
  }

  let outcome: Awaited<ReturnType<typeof publishCliToNpm>>;
  try {
    outcome = await publishCliToNpm(version);
  } catch (err) {
    console.error(
      `::error::${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
  if (outcome !== "published" || !verify) return 0;

  for (let attempt = 1; attempt <= VERIFY_TRIES; attempt++) {
    let printed = "";
    try {
      // From outside the checkout, so npx fetches the published package
      // rather than finding the workspace's own @oxagen/cli.
      printed = execFileSync(
        "npx",
        ["--yes", `${CLI_PACKAGE}@${version}`, "--version"],
        { cwd: tmpdir(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ).trim();
    } catch (err) {
      printed = err instanceof Error ? (err.message.split("\n")[0] ?? "") : "";
    }
    if (printed === version) {
      console.log(`npx ${CLI_PACKAGE}@${version} --version prints ${version}`);
      return 0;
    }
    console.log(
      `npx ${CLI_PACKAGE}@${version} --version printed "${printed}" (try ${attempt} of ${VERIFY_TRIES})`,
    );
    if (attempt < VERIFY_TRIES) await sleep(VERIFY_WAIT_MS);
  }
  console.error(
    `::error::npx ${CLI_PACKAGE}@${version} --version never printed ${version}`,
  );
  return 1;
}

exit(await main(argv.slice(2)));
