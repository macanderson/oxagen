import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      // lines floor 73 (measured 78.80); target 80 — raise in follow-up
      // branches floor 79 (measured 84.89); target 75 — already above target
      thresholds: {
        lines: 73,
        branches: 79,
        functions: 63,
        statements: 73,
      },
    },
  },
});
