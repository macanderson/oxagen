import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      // lines floor 78 (measured 83.48); target 80 — raise in follow-up
      // branches floor 78 (measured 83.33); target 75 — already above target
      thresholds: {
        lines: 78,
        branches: 78,
        functions: 68,
        statements: 78,
      },
    },
  },
});
