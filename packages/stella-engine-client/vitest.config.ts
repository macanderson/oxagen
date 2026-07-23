import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    clearMocks: true,
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
    // The live stella-serve round trip boots a real child process and does
    // its own readiness poll; give it more headroom than the default unit
    // timeout without slowing down the always-on wire-contract test.
    testTimeout: 20000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      thresholds: { lines: 80, branches: 70, functions: 80, statements: 80 },
    },
  },
});
