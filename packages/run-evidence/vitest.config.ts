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
      // Measured at first landing: 95.23 lines/statements, 91.52 branches,
      // 100 functions. Floors keep at least 2.5% headroom, capped at 90.
      thresholds: {
        lines: 90,
        branches: 88,
        functions: 90,
        statements: 90,
      },
    },
  },
});
