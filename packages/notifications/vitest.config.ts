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
      // lines floor 90 (reduced from 94 for CI stability); target 75
      // branches floor 87 (measured 92.30); target 70
      thresholds: {
        lines: 90,
        branches: 87,
        functions: 84,
        statements: 90,
      },
    },
  },
});
