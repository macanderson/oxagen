import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      // lines floor 50 (measured 49.75); auth.ts is Better Auth config (not unit-testable)
      // branches floor 94 (measured 94.28); above target of 85
      thresholds: {
        lines: 50,
        branches: 94,
        functions: 85,
        statements: 50,
      },
    },
  },
});
