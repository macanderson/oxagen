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
      exclude: [...coverageConfigDefaults.exclude, "src/**/*.test.ts", "src/index.ts", "src/protocol/index.ts"],
      // Set before CI first measured the package. Raise them to CI's numbers
      // less 2.5 points, capped at 90, once a run reports them.
      thresholds: { lines: 80, branches: 75, functions: 80, statements: 80 },
    },
  },
});
