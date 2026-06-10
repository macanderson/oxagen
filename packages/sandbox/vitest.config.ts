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
      exclude: ["src/types.ts", "vitest.config.ts"],
      thresholds: {
        lines: 97,
        branches: 92,
        functions: 97,
        statements: 97,
      },
    },
  },
});
