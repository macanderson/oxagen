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
      // OXA-1898: lines/statements raised to the 85% gate (measured 94.4).
      // branches/functions left at prior floors (measured 83.4 / 95.5).
      thresholds: {
        lines: 85,
        branches: 80,
        functions: 70,
        statements: 85,
      },
    },
  },
});
