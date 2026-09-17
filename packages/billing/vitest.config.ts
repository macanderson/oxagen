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
      // #3157: re-measured at 93.18 lines / 86.88 branches / 94.51 functions /
      // 93.18 statements. Each floor is floor(measured - 2.5), capped at 90, so
      // the gate keeps at least 2.5 points of headroom under environment noise.
      thresholds: {
        lines: 90,
        branches: 84,
        functions: 90,
        statements: 90,
      },
    },
  },
});
