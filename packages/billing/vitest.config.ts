import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      // lines floor 62 (measured 67.68); target 90 — raise in follow-up
      // branches floor 80 (measured 85.21); target 85 — raise in follow-up
      thresholds: {
        lines: 62,
        branches: 80,
        functions: 52,
        statements: 62,
      },
    },
  },
});
