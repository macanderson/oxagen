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
      // OXA-1898: lines/statements raised to the 85% gate (measured 99.84;
      // auth.ts Better Auth config is not imported by tests so it stays out of
      // the denominator). functions/branches floored at 90 (measured 97.5/97.8,
      // capped at 90). All keep ≥2.5% headroom below measured.
      thresholds: {
        lines: 85,
        branches: 90,
        functions: 90,
        statements: 85,
      },
    },
  },
});
