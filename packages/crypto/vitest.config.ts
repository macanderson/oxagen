import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      thresholds: {
        lines: 90,
        branches: 85,
        functions: 80,
        statements: 90,
      },
    },
  },
});
