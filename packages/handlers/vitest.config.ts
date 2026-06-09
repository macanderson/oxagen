import { defineConfig, coverageConfigDefaults } from "vitest/config";

export default defineConfig({
  test: {
    clearMocks: true,
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      // lines floor 84 (measured 89.81); target 80 — already above target
      // branches floor 77 (measured 82.49); target 75 — already above target
      thresholds: {
        lines: 84,
        branches: 77,
        functions: 74,
        statements: 84,
      },
      exclude: [
        // Preserve vitest default exclusions (test files, type declarations, etc.)
        ...coverageConfigDefaults.exclude,
        // plugin.*.ts — handlers shipped as part of the installable-plugins epic
        // (OXA-1573+). These files are explicitly OUT OF SCOPE for testing right
        // now because the plugin API surface is subject to change. They will be
        // covered once the plugin contracts stabilise. Tracked in Linear.
        "src/plugin.*.ts",
        // Pure barrel / registration wiring — no business logic.
        // index.ts re-exports all handlers; register.ts registers them with the
        // handler registry. Both are side-effect-only and have no branch logic.
        "src/index.ts",
        "src/register.ts",
      ],
    },
  },
});
