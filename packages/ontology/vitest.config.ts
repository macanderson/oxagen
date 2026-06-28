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
      // OXA-1898: lines/statements raised to the 85% gate (measured 94.7).
      // branches/functions left at prior floors (measured 80.0 / 88.2).
      thresholds: {
        lines: 85,
        branches: 70,
        functions: 63,
        statements: 85,
      },
    },
  },
});
