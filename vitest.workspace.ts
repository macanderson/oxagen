// Workspace test surface — covers all packages and apps that ship their own
// vitest config. The root `pnpm test` task runs each via Turborepo, but
// `pnpm vitest` at the root uses this workspace file for IDE / CLI runs.
// Every entry below must have a matching vitest.config.ts on disk — a stale or
// missing path is silently skipped, so a whole package's tests can disappear
// from a root run without any error.
//
// This is a discovery list, NOT a gate. `pnpm gate` runs `turbo run
// test:coverage`, which drives each package's own script and never reads this
// file, so a package missing a vitest.config.ts still "passes" coverage with no
// thresholds to fail against. Known offender: packages/mcp-config declares
// test:unit + test:coverage and has src/permissions.test.ts, but ships no
// vitest.config.ts — so it is absent from root runs here AND exempt from the
// coverage ratchet. Adding that config fixes both at once.
//
// apps/app is not listed: it runs Vitest 5 through its own `test:unit` task,
// which this root Vitest 3.2 workspace cannot load. apps/app_deprecated is not
// listed either: it is kept only for the parity gates until cutover.
//
// Vitest 3.2 deprecates this file in favour of `test.projects` in a root
// vitest.config.ts, and Vitest 4 removes it. Do not move it yet. Vitest looks
// for its config in the package's folder and then in each folder above it, so
// a root vitest.config.ts would load in packages/mcp-config, which has no
// config of its own. Give that package a config first.
export default [
  "packages/*/vitest.config.ts",
  "apps/api/vitest.config.ts",
  "apps/cli/vitest.config.ts",
  "apps/desktop/vitest.config.ts",
  "apps/mcp/vitest.config.ts",
  "apps/relay/vitest.config.ts",
  "tools/*/vitest.config.ts",
];
