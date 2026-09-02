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
    else if (entry.name === "skill.toml") {
      const bundle = relative(base, dirname(full));
      // A skill.toml sitting directly in the skills root has no bundle
      // directory of its own, so `relative` yields "" and the destination
      // collapses onto the install target itself — which `--force` would then
      // `rm -rf`, taking every previously installed skill with it. Every
      // bundle lives in its own directory (see README); skip anything else.
      if (bundle === "") {
        console.error(
          `oxagen-skills: ignoring ${full} — a skill must live in its own directory under the skills root`,
        );
        continue;
      }
      out.push(bundle);
    }
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

const USAGE =
  "usage: npx @oxagen/skills [install|list] [--dir <path>] [--force]";

const args = process.argv.slice(2);
const HELP_FLAGS = new Set(["help", "--help", "-h"]);
// A help flag is a command, not a modifier — without this an `npx @oxagen/skills
// --help` falls through to the default and writes files into the home directory.
const command = HELP_FLAGS.has(args[0])
  ? "help"
  : args[0] && !args[0].startsWith("-")
    ? args[0]
    : "install";

// Both spellings are accepted — `--dir=<path>` is the one people reach for out
// of habit, and reading only `--dir <path>` would silently install to the home
// directory instead of the path they named.
const inlineDir = args.find((arg) => arg.startsWith("--dir="));
const dirFlag = args.indexOf("--dir");
let dirValue;
if (inlineDir !== undefined) {
  dirValue = inlineDir.slice("--dir=".length);
  if (dirValue === "") {
    console.error(`oxagen-skills: --dir requires a path\n${USAGE}`);
    process.exit(1);
  }
} else if (dirFlag !== -1) {
  dirValue = args[dirFlag + 1];
  if (!dirValue || dirValue.startsWith("-")) {
    // Without this check `--dir --force` silently installs to the default target.
    console.error(`oxagen-skills: --dir requires a path\n${USAGE}`);
    process.exit(1);
  }
}
const target = dirValue ?? DEFAULT_TARGET;
const force = args.includes("--force");

if (command === "install") {
  await install(target, force);
} else if (command === "list") {
  await list();
} else {
  console.log(USAGE);
  process.exit(command === "help" ? 0 : 1);
}
