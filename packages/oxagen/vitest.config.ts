import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      // lines floor 81 (measured 86.73); target 80 — already above target
      // branches floor 78 (measured 83.59); target 75 — already above target
      thresholds: {
        lines: 81,
        branches: 78,
        functions: 71,
        statements: 81,
      },
    },
  },
});
