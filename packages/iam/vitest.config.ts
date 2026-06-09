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
      // lines floor 92 (measured 97.64); target 90 — already above target
      // branches floor 85 (measured 90.76); target 85 — at target
      thresholds: {
        lines: 92,
        branches: 85,
        functions: 82,
        statements: 92,
      },
    },
  },
});
