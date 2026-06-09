import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    clearMocks: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      // Instrument ALL source files, not only those a test happens to import —
      // otherwise untested files are invisible and the thresholds gate nothing.
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/index.ts", // re-export barrels: no executable logic
        "src/registry/types.ts", // pure type declarations
      ],
      // Ratchet floors set just below current measured coverage — measured with
      // the include above (lines 83.38 / branches 87.41 / functions 92.10) — so
      // the gate lives in the build, not in review. Raise as coverage grows —
      // never lower. (registry/sync-service.ts is the remaining low-coverage
      // file; raising its tests will let these floors climb further.)
      thresholds: {
        lines: 80,
        branches: 85,
        functions: 90,
        statements: 80,
      },
    },
  },
});
