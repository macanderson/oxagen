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
      // Ratcheted after plugins phase 1 (manifest + registry + kernel gate).
      // Measured 95.39 lines / 84.12 branches / 88.67 functions. Thresholds only go up.
      thresholds: {
        lines: 95,
        branches: 84,
        functions: 88,
        statements: 95,
      },
    },
  },
});
