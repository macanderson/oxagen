import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    clearMocks: true,
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
    // The smoke test boots a real stella-serve child and waits for its
    // readiness line; the unit suite never needs this long.
    testTimeout: 20000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      // The fake engine and the smoke test are test fixtures, not the
      // shipped client; measuring them would flatter the number.
      exclude: [
        "src/fake-engine.ts",
        "src/stella-serve.smoke.test.ts",
        "src/**/*.test.ts",
        "src/generated/**",
      ],
      thresholds: {
        lines: 90,
        branches: 80,
        functions: 90,
        statements: 90,
      },
    },
  },
});
