import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    clearMocks: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Several suites mock @oxagen/database via importOriginal and dynamically
    // re-import the module-under-test (state-store uses vi.resetModules() per
    // test). That cold-loads the full drizzle + schema graph each time, which
    // exceeds vitest's 5s default on CI's shared runners (passes in ~300ms
    // locally). Give cold module imports headroom so they don't false-fail.
    testTimeout: 20000,
    hookTimeout: 20000,
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
