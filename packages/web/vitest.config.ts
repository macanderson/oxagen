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
      exclude: ["src/index.ts", "vitest.config.ts"],
      // OXA-1898: lines/statements raised to the 85% gate (measured 89.3).
      // branches/functions left at prior floors (measured 96.2 / 87.5).
      thresholds: {
        lines: 85,
        branches: 75,
        functions: 80,
        statements: 85,
      },
    },
  },
});
