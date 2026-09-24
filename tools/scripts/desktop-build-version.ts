#!/usr/bin/env tsx
/**
 * desktop-build-version.ts: the version a desktop build carries (ADR-158).
 *
 *   tsx tools/scripts/desktop-build-version.ts plan    # writes version= and build= to $GITHUB_OUTPUT
 *   tsx tools/scripts/desktop-build-version.ts stamp <version>
 *
 * `plan` runs in a full-history checkout of the commit being built. It reads
 * the root version, finds the commit that set it, and counts the commits
 * since. The release commit itself answers `version=` (empty): its tag
 * publishes it. Any later commit answers `X.Y.(Z+1)-N` and `build=true`.
 *
 * `stamp` writes a version into every manifest of this checkout, so the app
 * bundle, the Rust crate and both sidecars report the build they are. The
 * workflow never commits the result.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { argv, env, exit } from "node:process";
import { buildVersion, releaseCommitArgs } from "./lib/build-version";
import { readRootVersion, setAllVersions } from "./lib/versions";

const ROOT = resolve(import.meta.dirname, "../..");

function git(args: string[]): string {
  const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0) {
    console.error(`git ${args.join(" ")} failed: ${result.stderr}`);
    exit(1);
  }
  return result.stdout.trim();
}

function output(values: Record<string, string>): void {
  const lines = Object.entries(values).map(([k, v]) => `${k}=${v}`);
  for (const line of lines) console.log(line);
  if (env.GITHUB_OUTPUT)
    appendFileSync(env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
}

const [command, value] = argv.slice(2);

if (command === "plan") {
  const release = readRootVersion(ROOT);
  if (git(["rev-parse", "--is-shallow-repository"]) === "true") {
    console.error(
      "plan needs the full history (actions/checkout fetch-depth: 0)",
    );
    exit(1);
  }
  const releaseCommit = git(releaseCommitArgs(release));
  if (releaseCommit === "") {
    console.error(`no commit on this history sets package.json to ${release}`);
    exit(1);
  }
  const count = Number(git(["rev-list", "--count", `${releaseCommit}..HEAD`]));
  const version = buildVersion(release, count);
  if (version === null) {
    console.log(
      `${git(["rev-parse", "HEAD"])} is the ${release} release commit; its desktop-v${release} tag publishes it.`,
    );
    output({ version: "", build: "false", release });
  } else {
    console.log(
      `${count} commits since ${release} (${releaseCommit.slice(0, 9)}).`,
    );
    output({ version, build: "true", release });
  }
} else if (command === "stamp" && value !== undefined) {
  for (const m of setAllVersions(ROOT, value, { build: true }))
    if (m.from !== value)
      console.log(`  ${m.from ?? "(none)"} → ${value}  ${m.file}`);
} else {
  console.error("usage: desktop-build-version.ts plan | stamp <version>");
  exit(2);
}
