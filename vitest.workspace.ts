// Workspace test surface — add a package here once it ships its own
// vitest config. The root `pnpm test` task runs each via Turborepo, but
// `pnpm vitest` at the root uses this workspace file for IDE / CLI runs.
export default [
  "packages/oxagen/vitest.config.ts",
];
