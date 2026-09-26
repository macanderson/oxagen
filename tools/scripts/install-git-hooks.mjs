#!/usr/bin/env node
/**
 * Install the lefthook git hooks, unless the machine has turned hooks off.
 *
 *   node tools/scripts/install-git-hooks.mjs
 *
 * The root `prepare` script runs on every `pnpm install`, including the
 * install pnpm starts on its own before a script when it finds the
 * dependencies out of date. It used to run `lefthook install` unconditionally,
 * so on a machine that turns hooks off with `LEFTHOOK=0` every install wrote
 * the hooks back into `.git/hooks` (2026-09-26, twice in one session).
 * `LEFTHOOK=0` stops lefthook from running a hook but not from installing
 * one, so this script reads the same variable and skips the install.
 *
 * It is a Node script, not a shell test in `package.json`, because `prepare`
 * also runs on Windows, where `[ ... ]` is not a command.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Whether this environment wants hooks installed. `LEFTHOOK=0` (or `false`)
 * is lefthook's own off switch, and `HUSKY=0` is set beside it on machines
 * that turn every hook manager off.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {boolean}
 */
export function shouldInstallHooks(env) {
  const off = (value) => value === "0" || value?.toLowerCase() === "false";
  return !off(env.LEFTHOOK) && !off(env.HUSKY);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (shouldInstallHooks(process.env)) {
    execFileSync("lefthook", ["install"], {
      stdio: "inherit",
      shell: process.platform === "win32",
    });
  }
}
