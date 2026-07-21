#!/usr/bin/env node
/**
 * `npx @oxagen/skills install` — copies the agent skill definitions bundled
 * with this package into the directory the oxagen CLI scans for user skills
 * (`~/.config/oxagen/skills`, see apps/cli/src/config/indexer.ts).
 *
 * Zero runtime dependencies: the installer only copies `skill.toml` bundles.
 *
 * Commands:
 *   install [--dir <path>] [--force]   copy bundled skills (default command)
 *   list                               print the bundled skill files
 */

import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const BUNDLED_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "skills",
);
const DEFAULT_TARGET = join(homedir(), ".config", "oxagen", "skills");

async function collectSkillBundles(root, out = [], base = root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) await collectSkillBundles(full, out, base);
    else if (entry.name === "skill.toml")
      out.push(relative(base, dirname(full)));
  }
  return out;
}

async function install(target, force) {
  const bundles = await collectSkillBundles(BUNDLED_DIR);
  if (bundles.length === 0) {
    console.error(
      "oxagen-skills: no bundled skill definitions found — corrupt install?",
    );
    process.exit(1);
  }
  await mkdir(target, { recursive: true });
  let copied = 0;
  let skipped = 0;
  for (const rel of bundles) {
    const source = join(BUNDLED_DIR, rel);
    const dest = join(target, rel);
    if (!force) {
      const exists = await stat(dest).then(
        () => true,
        () => false,
      );
      if (exists) {
        skipped++;
        continue;
      }
    }
    await mkdir(dirname(dest), { recursive: true });
    if (force) await rm(dest, { recursive: true, force: true });
    await cp(source, dest, { recursive: true });
    copied++;
  }
  console.log(
    `oxagen-skills: ${copied} skill definition${copied === 1 ? "" : "s"} installed to ${target}`,
  );
  if (skipped > 0)
    console.log(
      `oxagen-skills: ${skipped} already present (use --force to overwrite)`,
    );
  console.log(
    "oxagen-skills: the oxagen CLI picks these up automatically on next run",
  );
}

async function list() {
  const bundles = await collectSkillBundles(BUNDLED_DIR);
  for (const bundle of bundles) console.log(join(bundle, "skill.toml"));
  console.log(
    `${bundles.length} bundled skill definition${bundles.length === 1 ? "" : "s"}`,
  );
}

const args = process.argv.slice(2);
const command = args[0] && !args[0].startsWith("-") ? args[0] : "install";
const dirFlag = args.indexOf("--dir");
const target =
  dirFlag !== -1 && args[dirFlag + 1] ? args[dirFlag + 1] : DEFAULT_TARGET;
const force = args.includes("--force");

if (command === "install") {
  await install(target, force);
} else if (command === "list") {
  await list();
} else {
  console.log(
    "usage: npx @oxagen/skills [install|list] [--dir <path>] [--force]",
  );
  process.exit(command === "help" || command === "--help" ? 0 : 1);
}
