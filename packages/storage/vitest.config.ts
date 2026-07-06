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
      // Ratcheted after adding the fs driver + tests (measured 92.93 lines/
      // statements, 87.87 branches, 95.83 functions). Each floor kept ≥2.5%
      // below measured per the coverage-ratchet rule (functions capped at 90).
      thresholds: {
        lines: 90,
        branches: 85,
        functions: 90,
        statements: 90,
      },
    },
  },
});
