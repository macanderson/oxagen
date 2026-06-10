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
      // lines 71 (measured 71.96) — migrate.ts database ops not covered without live CH
      // branches 95 (measured 95.65) — target 95; only migrate.ts cold-start path uncovered
      thresholds: {
        lines: 71,
        branches: 95,
        functions: 86,
        statements: 71,
      },
    },
  },
});
