import { coverageConfigDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    clearMocks: true,
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      exclude: [...coverageConfigDefaults.exclude, "src/index.ts"],
      // These floors only move up, and stay at least 2.5% below actual
      // coverage, capped at 90.
      thresholds: {
        lines: 90,
        branches: 88,
        functions: 90,
        statements: 90,
      },
    },
  },
});
