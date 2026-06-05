import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      // lines floor 44 (measured 49.73); target 90 — raise in follow-up
      // branches floor 86 (measured 91.80); target 85 — already above target, keep at measured-5
      thresholds: {
        lines: 44,
        branches: 86,
        functions: 34,
        statements: 44,
      },
    },
  },
});
