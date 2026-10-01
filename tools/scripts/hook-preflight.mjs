#!/usr/bin/env node
/**
 * Say plainly when a hook's check cannot run, before it runs.
 *
 *   node tools/scripts/hook-preflight.mjs check:contracts && pnpm check:contracts
 *   node tools/scripts/hook-preflight.mjs tools/scripts/typecheck-staged.mjs && node tools/scripts/typecheck-staged.mjs {staged_files}
 *
 * `lefthook.yml`'s pre-push commands run root scripts such as
 * `pnpm check:contracts` and `pnpm env:check`. Those scripts import workspace
 * and npm packages. In a checkout installed with `pnpm install --filter`, some
 * of them are not installed, and the script died on `ERR_MODULE_NOT_FOUND`.
 * That reads exactly like a check that ran and failed, and the obvious way
 * past it is `git push --no-verify`, which skips every other pre-push check
 * too (#3403).
 *
 * This walks the named root script the way `tools/scripts/lib/script-deps.mjs`
 * reads it: every `node` or `tsx` entry, every package those files import at
 * run time, and `tsx` itself when the script uses it. When one of those is a
 * workspace package, it also checks the packages that workspace package
 * declares, from the package's own directory, since a filtered install can
 * link a workspace package without installing its dependencies. If one is
 * not installed where Node would look for it, it prints which one, says the
 * check did not run, and exits 3. Exit 3 means "could not run", never "ran
 * and failed"; the checks themselves exit 1.
 *
 * It checks presence, not versions, and it reads files only, so it adds a few
 * tens of milliseconds to a push.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  entriesOf,
  installedPackageDir,
  packagesImportedBy,
  usesTsx,
} from "./lib/script-deps.mjs";
import { isEntrypoint } from "./lib/is-entrypoint.mjs";

/** The exit code for "this check could not run". */
export const CANNOT_RUN = 3;

/**
 * The command a preflight target stands for. A target with a slash and a
 * script extension is a file the hook runs directly (`node` for JavaScript,
 * `tsx` for TypeScript). Anything else names a root package.json script.
 *
 * @param {string} target
 * @param {Record<string, string>} scripts
 * @returns {{ command: string | undefined, label: string }}
 */
export function commandFor(target, scripts) {
  if (target.includes("/") && /\.(mjs|cjs|js|ts|mts|cts)$/.test(target)) {
    const runner = /\.(mjs|cjs|js)$/.test(target) ? "node" : "tsx";
    return { command: `${runner} ${target}`, label: `${runner} ${target}` };
  }
  return { command: scripts[target], label: `pnpm ${target}` };
}

/**
 * What the named root script, or script file, needs that this checkout lacks.
 *
 * @param {string} name a root package.json script, such as `check:contracts`,
 *   or a repo-relative script file, such as `tools/scripts/typecheck-staged.mjs`
 * @param {{
 *   repoRoot: string,
 *   read: (p: string) => string,
 *   exists: (p: string) => boolean,
 *   loadTs: () => Promise<typeof import("typescript")>,
 *   realpath?: (p: string) => string,
 * }} io
 * @returns {Promise<{ missing: { name: string, neededBy: string }[], unknownScript: boolean }>}
 */
export async function preflight(
  name,
  { repoRoot, read, exists, loadTs, realpath = (p) => p },
) {
  const { scripts = {} } = JSON.parse(read(join(repoRoot, "package.json")));
  const { command, label } = commandFor(name, scripts);
  const isFile = !label.startsWith("pnpm ");
  if (command === undefined || (isFile && !exists(resolve(repoRoot, name)))) {
    return { missing: [], unknownScript: true };
  }

  const missing = [];
  const walked = new Set();
  const need = (pkg, neededBy, fromDir = repoRoot) => {
    const dir = installedPackageDir(pkg, fromDir, repoRoot, exists);
    if (!dir) {
      if (!missing.some((m) => m.name === pkg)) {
        missing.push({ name: pkg, neededBy });
      }
      return;
    }
    // A workspace package is a link to its own directory in the tree. Its
    // code runs from there and resolves its own imports from there, so the
    // packages it declares must be installed there too. `pnpm install
    // --filter @oxagen/recorder...` links `@oxagen/oxagen` at the root and
    // installs none of its dependencies, so `docs:schemas --check` died on
    // "Cannot find package 'zod'" after this preflight had passed (scratch
    // run 36664757916). npm packages are not walked: pnpm installs a
    // package's own dependencies with it.
    const real = realpath(dir);
    const rel = relative(repoRoot, real);
    const inTree =
      rel !== "" &&
      !rel.startsWith("..") &&
      !isAbsolute(rel) &&
      !rel.split(/[\\/]/).includes("node_modules");
    if (!inTree || walked.has(real)) return;
    walked.add(real);
    let dependencies = {};
    try {
      ({ dependencies = {} } = JSON.parse(read(join(real, "package.json"))));
    } catch {
      return;
    }
    const manifest = relative(repoRoot, join(real, "package.json"));
    for (const dep of Object.keys(dependencies)) {
      need(dep, `${pkg}, declared in ${manifest}`, real);
    }
  };

  if (usesTsx(command, scripts)) need("tsx", "package.json");

  // The import walk parses each file with TypeScript. The root declares it,
  // but a checkout that lacks it cannot be walked, and that is itself the
  // answer: report it rather than throw a module-resolution error, which is
  // the very failure this script exists to replace.
  let ts;
  try {
    ts = await loadTs();
  } catch {
    need("typescript", "tools/scripts/hook-preflight.mjs");
    return { missing, unknownScript: false };
  }

  const entries = entriesOf(command, scripts);
  const imported = packagesImportedBy(repoRoot, entries, { read, exists, ts });
  for (const [pkg, file] of imported) {
    need(pkg, file, dirname(resolve(repoRoot, file)));
  }
  return { missing, unknownScript: false };
}

/**
 * The filtered install the message names. #3403 asked that a fresh worktree
 * installed with `pnpm install --filter @oxagen/cli... --filter
 * oxagen-monorepo...` run `pnpm check:contracts` to completion, and #4879
 * folded the recorder's commands into that CLI, so it is the one filtered
 * install a person needs to run the root checks.
 */
export const FILTERED_INSTALL_PACKAGE = "@oxagen/cli";

/**
 * The message a person reads when the check cannot run.
 *
 * It gives two ways out. A full `pnpm install` always works. A filtered
 * install works too once it holds the CLI and the root package's own
 * dependency graph (`--filter @oxagen/cli... --filter <root>...`), which
 * installs every workspace package the root scripts run, such as
 * `@oxagen/oxagen` and its `zod` (scratch run 36665719175, step F5).
 *
 * @param {string} name
 * @param {{ missing: { name: string, neededBy: string }[], unknownScript: boolean }} result
 * @param {string} [rootPackage] the root package.json `name`
 * @returns {string}
 */
export function report(name, result, rootPackage = "oxagen-monorepo") {
  const { label } = commandFor(name, {});
  if (result.unknownScript) {
    return label.startsWith("pnpm ")
      ? `hook-preflight: the root package.json has no "${name}" script, so the hook that runs it cannot run.\n`
      : `hook-preflight: ${name} does not exist, so the hook that runs it cannot run.\n`;
  }
  const lines = [
    `hook-preflight: \`${label}\` could not run, so it neither passed nor failed.`,
    ...result.missing.map(
      (m) => `  ${m.name} is not installed (needed by ${m.neededBy}).`,
    ),
    "This checkout is missing packages, which usually means it was installed with `pnpm install --filter`.",
    "Run `pnpm install` at the repository root, then try again.",
    `To keep a filtered install, install the oxagen CLI and the root with it: \`pnpm install --filter ${FILTERED_INSTALL_PACKAGE}... --filter ${rootPackage}...\`. Add \`--filter <your package>...\` for the package you work on.`,
  ];
  return `${lines.join("\n")}\n`;
}

if (isEntrypoint(import.meta.url)) {
  const name = process.argv[2];
  if (!name) {
    process.stderr.write(
      "usage: node tools/scripts/hook-preflight.mjs <root-script | script-file>\n",
    );
    process.exit(2);
  }
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const result = await preflight(name, {
    repoRoot,
    read: (p) => readFileSync(p, "utf8"),
    exists: existsSync,
    loadTs: async () => (await import("typescript")).default,
    realpath: realpathSync,
  });
  if (result.unknownScript || result.missing.length > 0) {
    const { name: rootPackage } = JSON.parse(
      readFileSync(join(repoRoot, "package.json"), "utf8"),
    );
    process.stderr.write(report(name, result, rootPackage));
    process.exit(CANNOT_RUN);
  }
}
