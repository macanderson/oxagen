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
      // Measured at first landing: 95.3 lines/statements, 89.5 branches,
      // 98 functions. Floors keep the mandated 2.5% headroom, capped at 90.
      thresholds: {
        lines: 90,
        branches: 86,
        functions: 90,
        statements: 90,
      },
    },
  },
});
