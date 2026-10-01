import { configDefaults, defineConfig } from "vitest/config";

// The tests that read files outside @oxagen/scripts: the guards that scan
// every package's source, and the ones that read the workflows, the docs,
// or another package's files (#4664 item 2). vitest.config.ts leaves them
// out of turbo's cached `test:unit` and `test:coverage` tasks, because
// turbo hashes those over this package's own files and would replay a pass
// after the files these tests read had changed.
//
// `pnpm check:tree-guards` runs this config with vitest directly, never
// through turbo, so every run reads the current tree. The checks job runs it
// on every pull request and every push to main, and `pnpm gate` runs it too.
export default defineConfig({
  test: {
    clearMocks: true,
    environment: "node",
    globals: false,
    include: ["**/*.tree.test.ts"],
    exclude: [...configDefaults.exclude],
  },
});
