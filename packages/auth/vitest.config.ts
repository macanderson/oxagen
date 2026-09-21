import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    clearMocks: true,
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
    // Four tests in auth.test.ts assert what happens at module-evaluation
    // time — the startup guard's throw, its two bypasses, and the kmsAdapter
    // branch — so each one calls `vi.resetModules()` and re-imports `auth.ts`
    // and its whole mocked dependency graph inside the test body. That re-import
    // is the assertion; it cannot move to a hook. It costs ~0.58s idle, which
    // fits the 5s default with room to spare, and does not fit it in the
    // nightly's parallel run over every package: on 2026-09-20 that file spent
    // 46s in collect alone and the first of the four timed out at 5000ms,
    // failing `full (test:unit)` on a green tree (run 35512150616). 20s is the
    // figure `packages/plugins`, `packages/stella-engine-client` and
    // `apps/app` already use for the same reason.
    testTimeout: 20_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      // Thresholds keep at least 2.5% headroom below measured coverage.
      // auth.test.ts imports auth.ts directly (with its dependencies mocked)
      // and exercises the betterAuth config, so auth.ts is included in the
      // coverage denominator.
      thresholds: {
        lines: 85,
        branches: 90,
        functions: 90,
        statements: 85,
      },
    },
  },
});
