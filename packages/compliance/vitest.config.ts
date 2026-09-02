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
      // Single-source compliance constants + pure generators. The floor is a
      // ratchet: raise it toward actual coverage, never lower it.
      // Actual: 97.59 lines/statements, 87.5 branches/functions. Each floor is
      // set to floor(actual − 2.5) per the repo ratchet policy, capped at 90.
      thresholds: {
        lines: 95,
        branches: 85,
        functions: 85,
        statements: 95,
      },
    },
  },
});
