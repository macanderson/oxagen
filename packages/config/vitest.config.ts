import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // Scope to the files that have tests; index.ts is a pure re-export barrel
      // with a PORTS constant — no logic to assert, nothing to fail against.
      include: ["src/env.ts"],
      // Current measured floor (2026-06-02):
      //   env.ts: stmts 100% | branch 100% | funcs 100% | lines 100%
      // Ratchet target: 85% lines / 80% branch once all source files have tests.
      thresholds: {
        lines: 100,
        branches: 100,
        functions: 100,
        statements: 100,
      },
    },
  },
});
