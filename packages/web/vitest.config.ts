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
      exclude: ["src/index.ts", "vitest.config.ts"],
      thresholds: {
        lines: 85,
        branches: 75,
        functions: 80,
        statements: 85,
      },
    },
  },
});
