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
      // #2974: the scope-guard suite lifted every metric past the 90 cap
      // (measured 95.33 / 93.80 / 97.91 / 95.33), so all four sit at the
      // ceiling the ratchet allows.
      thresholds: {
        lines: 90,
        branches: 90,
        functions: 90,
        statements: 90,
      },
    },
  },
});
