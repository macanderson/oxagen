import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      // lines floor 68 (measured 73.81); target 75 — raise in follow-up
      // branches floor 64 (measured 69.51); target 70 — raise in follow-up
      thresholds: {
        lines: 68,
        branches: 64,
        functions: 58,
        statements: 68,
      },
    },
  },
});
