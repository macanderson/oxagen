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
      exclude: [
        ...coverageConfigDefaults.exclude,
        "src/index.ts",
        "src/store/index.ts",
        "src/migration/index.ts",
      ],
      // OXA-1898: lines/statements raised to the 85% gate (measured 88.7).
      // branches/functions left at prior floors (measured 82.7 / 86.4).
      thresholds: {
        lines: 85,
        branches: 75,
        functions: 80,
        statements: 85,
      },
    },
  },
});
