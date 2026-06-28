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
      // OXA-1898: enforce the 85% lines/statements gate (measured 87.5).
      // functions/branches (~66.7) are barrels + lazy callbacks and are not
      // gated here.
      thresholds: {
        lines: 85,
        statements: 85,
      },
    },
  },
});
