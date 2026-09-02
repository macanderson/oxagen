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
export default [
  "packages/*/vitest.config.ts",
  "apps/api/vitest.config.ts",
  "apps/app/vitest.config.ts",
  "apps/cli/vitest.config.ts",
  "apps/mcp/vitest.config.ts",
  "apps/schemas/vitest.config.ts",
  "tools/*/vitest.config.ts",
];
