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
      // Ratcheted after the full contract test sweep (measured 91.96 lines /
      // 83.33 branches / 80 functions). Thresholds only go up.
      thresholds: {
        lines: 91,
        branches: 83,
        functions: 80,
        statements: 91,
      },
    },
  },
});
