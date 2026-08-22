// Workspace test surface — covers all packages and apps that ship their own
// vitest config. The root `pnpm test` task runs each via Turborepo, but
// `pnpm vitest` at the root uses this workspace file for IDE / CLI runs.
export default [
  "packages/*/vitest.config.ts",
  "apps/api/vitest.config.ts",
  "apps/app/vitest.config.ts",
  "apps/mcp/vitest.config.ts",
  "apps/schemas/vitest.config.ts",
  "tools/scripts/vitest.config.ts",
];
