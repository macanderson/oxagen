import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      // lines floor 58 (measured 63.92); target 80 — raise in follow-up
      // branches floor 75 (measured 80.64); target 75 — at target
      thresholds: {
        lines: 58,
        branches: 75,
        functions: 48,
        statements: 58,
      },
    },
  },
});
