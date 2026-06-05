import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      // lines floor 94 (measured 99.39); target 75 — already above target
      // branches floor 86 (measured 91.07); target 70 — already above target
      thresholds: {
        lines: 94,
        branches: 86,
        functions: 84,
        statements: 94,
      },
    },
  },
});
