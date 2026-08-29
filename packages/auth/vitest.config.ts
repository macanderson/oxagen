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
      // Thresholds keep at least 2.5% headroom below measured coverage.
      // auth.test.ts imports auth.ts directly (with its dependencies mocked)
      // and exercises the betterAuth config, so auth.ts is included in the
      // coverage denominator.
      thresholds: {
        lines: 85,
        branches: 90,
        functions: 90,
        statements: 85,
      },
    },
  },
});
