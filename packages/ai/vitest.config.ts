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
      // OXA-1898: lines/statements raised to the 85% gate (measured 91.3).
      // branches/functions left at prior floors (measured 84.1 / 81.8).
      thresholds: {
        lines: 85,
        branches: 79,
        functions: 63,
        statements: 85,
      },
    },
  },
});
