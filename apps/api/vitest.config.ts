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
        "src/index.ts",
        "src/vercel.ts",
        "src/bootstrap.ts",
      ],
      // Ratchet floors raised after the document/form/image, graph, and
      // integration/plugin/repo/semantic/web route-test sweep: measured
      // 87.35% lines / 88.59% branches / 90.62% functions.
      // Keep raising as coverage grows — never lower.
      thresholds: {
        lines: 87,
        branches: 88,
        functions: 90,
        statements: 87,
      },
    },
  },
});
