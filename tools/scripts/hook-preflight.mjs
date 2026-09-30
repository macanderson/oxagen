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
 * run time, and `tsx` itself when the script uses it. If one is not installed
 * where Node would look for it, it prints which one, says the check did not
 * run, and exits 3. Exit 3 means "could not run", never "ran and failed"; the
 * checks themselves exit 1.
 *
 * It checks presence, not versions, and it reads files only, so it adds a few
 * tens of milliseconds to a push.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
 * }} io
 * @returns {Promise<{ missing: { name: string, neededBy: string }[], unknownScript: boolean }>}
 */
export async function preflight(name, { repoRoot, read, exists, loadTs }) {
  const { scripts = {} } = JSON.parse(read(join(repoRoot, "package.json")));
  const { command, label } = commandFor(name, scripts);
  const isFile = !label.startsWith("pnpm ");
  if (command === undefined || (isFile && !exists(resolve(repoRoot, name)))) {
    return { missing: [], unknownScript: true };
  }

  const missing = [];
  const need = (pkg, neededBy, fromDir = repoRoot) => {
    if (!installedPackageDir(pkg, fromDir, repoRoot, exists)) {
      missing.push({ name: pkg, neededBy });
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
 * The message a person reads when the check cannot run.
 *
 * @param {string} name
 * @param {{ missing: { name: string, neededBy: string }[], unknownScript: boolean }} result
 * @returns {string}
 */
export function report(name, result) {
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
  });
  if (result.unknownScript || result.missing.length > 0) {
    process.stderr.write(report(name, result));
    process.exit(CANNOT_RUN);
  }
}
