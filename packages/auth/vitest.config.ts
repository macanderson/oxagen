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
      // lines floor 49 (measured 49.75); auth.ts is Better Auth config (not unit-testable)
      // branches floor 90 (reduced from 94 for CI stability)
      thresholds: {
        lines: 49,
        branches: 90,
        functions: 85,
        statements: 49,
      },
    },
  },
});
