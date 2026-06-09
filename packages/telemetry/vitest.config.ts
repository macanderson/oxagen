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
      // lines floor 40 (measured 45.04); target 80 — raise in follow-up
      // branches floor 71 (measured 76.66); target 75 — raise in follow-up
      thresholds: {
        lines: 40,
        branches: 71,
        functions: 30,
        statements: 40,
      },
    },
  },
});
