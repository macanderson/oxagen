import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      // Scope to the files that have tests; index.ts is a pure re-export barrel
      // with a PORTS constant — no logic to assert, nothing to fail against.
      include: ["src/env.ts"],
      // lines floor 100 (measured 100); target 75 — already above target
      // branches floor 100 (measured 100); target 70 — already above target
      thresholds: {
        lines: 100,
        branches: 100,
        functions: 100,
        statements: 100,
      },
    },
  },
});
