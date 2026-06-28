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
      // OXA-1898: lines/statements raised to the 85% gate (measured 98.1; the
      // migrate.ts live-CH path is not imported by the unit suite so it stays
      // out of the denominator). branches/functions left at prior floors.
      thresholds: {
        lines: 85,
        branches: 95,
        functions: 86,
        statements: 85,
      },
    },
  },
});
