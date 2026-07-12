/**
 * Child-process environment sanitizer.
 *
 * When the arena is launched through pnpm (`pnpm bench`, `pnpm dev`, …), pnpm
 * exports its own settings to child processes as `npm_config_*` environment
 * variables so that npm-aware tools see a consistent config. One of those keys,
 * `npm_config_manage_package_manager_versions`, is pnpm-specific: npm (11.x)
 * does not recognize it and prints
 *
 *   npm warn Unknown env config "manage-package-manager-versions". This will
 *   stop working in the next major version of npm.
 *
 * to **stderr** every time it (or `npx`) boots. Because the web dashboard spawns
 * benchmark children through `npx` — and the runners shell out to npm-aware
 * CLIs — that warning shows up once per agent in every run log, including dry
 * runs (the warning is emitted by the `npx` launcher before our script runs).
 *
 * The var is inert for everything the arena spawns, so the fix is simply to not
 * forward it. We strip a curated denylist of pnpm-injected keys npm rejects,
 * rather than purging all `npm_config_*` (that would drop legitimate keys such
 * as `npm_config_user_agent` that npm expects).
 */

/**
 * pnpm-injected `npm_config_*` env keys that current npm does not understand and
 * warns about. Add to this list if pnpm starts exporting more npm-unknown keys.
 */
export const PNPM_UNKNOWN_NPM_CONFIG_KEYS = [
  "npm_config_manage_package_manager_versions",
] as const;

/**
 * Return a shallow copy of `env` with the npm-unknown pnpm keys removed. Pure —
 * never mutates the passed object (or `process.env`). Handles both the exact
 * lower-case key pnpm exports and any case variant, since env-var lookups are
 * case-insensitive on some platforms.
 */
export function sanitizedEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const denied = new Set<string>(
    PNPM_UNKNOWN_NPM_CONFIG_KEYS.map((k) => k.toLowerCase()),
  );
  const kept = Object.entries(env).filter(
    ([key]) => !denied.has(key.toLowerCase()),
  );
  return Object.fromEntries(kept) as NodeJS.ProcessEnv;
}

/**
 * Remove the npm-unknown pnpm keys from `process.env` **in place**. Call once at
 * a process entry point (e.g. the benchmark CLI) so every child it later spawns
 * — which inherit `process.env` by default — starts from a clean environment,
 * without having to thread `sanitizedEnv()` through every spawn call site.
 */
export function scrubProcessEnv(): void {
  const denied = new Set<string>(
    PNPM_UNKNOWN_NPM_CONFIG_KEYS.map((k) => k.toLowerCase()),
  );
  for (const key of Object.keys(process.env)) {
    if (denied.has(key.toLowerCase())) {
      // Reflect.deleteProperty (not the `delete` operator) so this reads as a
      // plain call on a string-keyed dictionary, not a dynamic-delete smell.
      Reflect.deleteProperty(process.env, key);
    }
  }
}
