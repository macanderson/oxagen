import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      // lines floor 37 (measured 42.48); target 75 — raise in follow-up
      // branches floor 92 (measured 97.82); target 70 — already above target
      thresholds: {
        lines: 37,
        branches: 92,
        functions: 30,
        statements: 37,
      },
    },
  },
});
