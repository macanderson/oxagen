import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      // floor 79 (measured 84.81); target 90 — raise in follow-up
      // floor 65 (measured 70.37); target 85 branches — raise in follow-up
      thresholds: {
        lines: 79,
        branches: 65,
        functions: 60,
        statements: 79,
      },
    },
  },
});
