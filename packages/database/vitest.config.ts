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
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.spec.ts",
        "src/**/*.mock.ts",
        // types.ts contains ONLY `import type` / `export type` declarations —
        // zero executable JavaScript is emitted. Excluding it avoids a false 0%
        // function/line hit that would unfairly depress the coverage gate.
        "src/types.ts",
      ],
      // Ratchet rule: floor(measured coverage − 2.5), capped at 90, never
      // below the prior value. Raise these only when the new number leaves
      // that headroom — never lower them.
      thresholds: {
        lines: 85,
        branches: 90,
        functions: 66,
        statements: 85,
      },
    },
  },
});
