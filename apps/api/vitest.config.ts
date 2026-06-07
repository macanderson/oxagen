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
      // Ratchet floors raised after route-handler tests were added:
      // measured 99.21% lines / 98.17% branches / 95.45% functions.
      // Keep raising as coverage grows — never lower.
      thresholds: {
        lines: 90,
        branches: 90,
        functions: 92,
        statements: 90,
      },
    },
  },
});
