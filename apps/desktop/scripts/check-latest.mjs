#!/usr/bin/env node
/**
 * Exit 0 when a downloaded `latest.json` names `<version>` or a newer one.
 *
 *   node scripts/check-latest.mjs <path to latest.json> <version> [name]
 *
 * The desktop workflow's publish job runs this against
 * https://downloads.oxagen.sh/latest.json after an upload, and against the
 * update feed, https://downloads.oxagen.sh/updater/latest.json, after a
 * release (ADR-245). Newer is a pass: a release and a deploy build can finish
 * in either order, and the older one leaves `latest/` where it is (ADR-158).
 * `name` is what the messages call the file.
 */
import { readFileSync } from "node:fs";
import { compareVersions, readLatestVersion } from "../src/downloads.ts";

const [path, version, name = "downloads.oxagen.sh/latest"] =
  process.argv.slice(2);
if (path === undefined || version === undefined) {
  console.error("usage: check-latest.mjs <latest.json> <version> [name]");
  process.exit(2);
}
const latest = readLatestVersion(readFileSync(path, "utf8"));
if (latest === null) {
  console.error(`${path} names no version`);
  process.exit(1);
}
if (compareVersions(latest, version) < 0) {
  console.error(`latest is ${latest}, older than ${version}`);
  process.exit(1);
}
console.log(
  latest === version
    ? `${name} names ${version}`
    : `${name} names ${latest}, newer than ${version}`,
);
