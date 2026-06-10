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
      thresholds: {
        lines: 99,
        branches: 97,
        functions: 90,
        statements: 99,
      },
    },
  },
});
