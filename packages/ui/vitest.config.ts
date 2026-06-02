import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    // Include both .ts and .tsx test files (buttonVariants test is .tsx)
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    coverage: {
      provider: "v8",
      // Scope coverage to the two files that have tests.
      // The remaining components are Radix-based JSX that require a DOM renderer
      // and @testing-library/react — tracked as a follow-up to add render tests.
      // Including them here would collapse coverage to ~6% and make CI useless.
      include: ["src/lib/utils.ts", "src/components/button.tsx"],
      // Current measured floor (2026-06-02):
      //   utils.ts:   stmts 100% | branch 100% | funcs 100% | lines 100%
      //   button.tsx: stmts  91% | branch 100% | funcs 100% | lines  91%
      //               (lines 41-43 are the JSX render path, no DOM renderer)
      // Ratchet target: 85% lines / 80% branch once render tests are added.
      thresholds: {
        lines: 91,
        branches: 100,
        functions: 100,
        statements: 91,
      },
    },
  },
});
