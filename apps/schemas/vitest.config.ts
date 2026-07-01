import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    clearMocks: true,
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["scripts/**/*.ts", "src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      // Small, single-purpose package: the generator + its drift test are
      // exercised end-to-end by schema-drift.test.ts. Ratchet cap 90.
      thresholds: {
        lines: 90,
        branches: 85,
        functions: 90,
        statements: 90,
      },
    },
  },
});
