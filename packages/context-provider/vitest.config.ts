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
        // Reads the environment and constructs a real store; driven end to end
        // by stdio.test.ts through a child process, which v8 coverage in this
        // process cannot see.
        "src/bin.ts",
        "src/testing/**",
      ],
      thresholds: {
        lines: 90,
        branches: 88,
        functions: 90,
        statements: 90,
      },
    },
  },
});
