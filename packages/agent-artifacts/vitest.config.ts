import { defineConfig } from "vitest/config";

// Without this file the package is invisible to the root `vitest.workspace.ts`
// glob (`packages/*/vitest.config.ts`), which skips a missing path silently —
// so the artifact codec, hash, and containment tests never ran in a root pass.
//
// `coverage.thresholds` is deliberately absent until someone measures the real
// numbers and sets a floor with the usual 2.5% headroom. Adding a guessed floor
// would be worse than none: it either fails CI on noise or ratchets to a number
// nobody verified.
export default defineConfig({
  test: {
    clearMocks: true,
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**"],
    },
  },
});
