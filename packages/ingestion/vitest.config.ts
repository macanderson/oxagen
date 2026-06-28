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
      // OXA-1898: lines/statements raised to the 85% gate (measured 89.9).
      // branches/functions left at prior floors (measured 84.1 / 87.7).
      thresholds: {
        lines: 85,
        branches: 80,
        functions: 78,
        statements: 85,
      },
    },
  },
});
