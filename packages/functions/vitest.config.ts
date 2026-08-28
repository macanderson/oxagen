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
      // Only lines/statements are gated. Branches stay ungated because this
      // package is mostly type barrels and lazy callbacks with few branches.
      thresholds: {
        lines: 85,
        statements: 85,
      },
    },
  },
});
