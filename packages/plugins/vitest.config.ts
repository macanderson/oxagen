import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      // Ratchet floors set just below current measured coverage
      // (lines 77.76 / branches 84.05 / functions 82.92) so the gate lives in
      // the build, not in review. Raise as coverage grows — never lower.
      thresholds: {
        lines: 75,
        branches: 80,
        functions: 80,
        statements: 75,
      },
    },
  },
});
