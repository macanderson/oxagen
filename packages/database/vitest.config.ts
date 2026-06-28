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
      // Thresholds updated after adding relations, client, seed, and schema-smoke
      // tests (OXA-1894). Measured (2026-06-28): lines=94.21% stmts=94.21%
      // branches=97.58% funcs=69.23%.
      // Ratchet rule: floor(measured − 2.5), capped at 90, never below prior value.
      //   lines/stmts: 85 (floor(94.21−2.5)=91, cap=90, but target spec says 85)
      //   branches: 90 (floor(97.58−2.5)=95, cap=90)
      //   functions: 66 (floor(69.23−2.5)=66)
      thresholds: {
        lines: 85,
        branches: 90,
        functions: 66,
        statements: 85,
      },
    },
  },
});
