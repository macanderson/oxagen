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
      // OXA-1898: lines/statements raised to the 85% gate (measured 91.8).
      // branches/functions left at prior floors (measured 85.9 / 94.1).
      thresholds: {
        lines: 85,
        branches: 78,
        functions: 68,
        statements: 85,
      },
    },
  },
});
