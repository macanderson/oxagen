import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/index.ts",
        "src/vercel.ts",
        "src/bootstrap.ts",
      ],
      // Ratchet floors set just below current measured coverage
      // (lines 63.47 / branches 96.63 / functions 95.45) so the gate lives in
      // the build, not in review. Raise as coverage grows — never lower.
      thresholds: {
        lines: 62,
        branches: 90,
        functions: 92,
        statements: 62,
      },
    },
  },
});
