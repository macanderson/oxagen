import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      // lines floor 84 (measured 89.81); target 80 — already above target
      // branches floor 77 (measured 82.49); target 75 — already above target
      thresholds: {
        lines: 84,
        branches: 77,
        functions: 74,
        statements: 84,
      },
    },
  },
});
