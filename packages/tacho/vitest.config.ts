import { coverageConfigDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    clearMocks: true,
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      exclude: [
        ...coverageConfigDefaults.exclude,
        "src/index.ts",
        "src/trace/index.ts",
        "src/claude-code/index.ts",
      ],
      // Ratchet only: never lowered, capped at 90, with headroom below the
      // measured figure so environment noise cannot fail CI.
      thresholds: {
        lines: 85,
        branches: 80,
        functions: 85,
        statements: 85,
      },
    },
  },
});
