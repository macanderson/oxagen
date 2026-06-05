import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      // lines floor 85 (measured 90.26); target 80 — already above target
      // branches floor 75 (measured 80.43); target 75 — at target
      thresholds: {
        lines: 85,
        branches: 75,
        functions: 75,
        statements: 85,
      },
    },
  },
});
