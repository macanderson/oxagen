import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      // lines floor 94 (measured 99.20); target 75 — already above target
      // branches floor 87 (measured 92.30); target 70 — already above target
      thresholds: {
        lines: 94,
        branches: 87,
        functions: 84,
        statements: 94,
      },
    },
  },
});
