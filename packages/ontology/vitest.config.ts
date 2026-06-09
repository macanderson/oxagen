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
      // branches measured 75.00 — at target
      thresholds: {
        lines: 63,
        branches: 70,
        functions: 63,
        statements: 63,
      },
    },
  },
});
