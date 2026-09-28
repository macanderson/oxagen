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
      // Instrument every source file, so a module no test imports still
      // counts against the thresholds.
      include: ["src/**/*.ts"],
      exclude: [
        ...coverageConfigDefaults.exclude,
        "src/**/*.test.ts",
        "src/index.ts",
        // Test support: a stand-in Cedar evaluator and fixture loaders.
        "src/testing/**",
      ],
      // A first measure. Raise each to CI's number less 2.5 points, capped at 90.
      thresholds: { lines: 85, branches: 80, functions: 85, statements: 85 },
    },
  },
});
