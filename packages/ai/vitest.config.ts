import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    clearMocks: true,
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      // branches floor 79 (measured 84.89); target 75 — already above target
      thresholds: {
        lines: 78,
        branches: 79,
        functions: 63,
        statements: 78,
      },
    },
  },
});
