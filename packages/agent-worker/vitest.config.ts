import { defineConfig, coverageConfigDefaults } from "vitest/config";

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
        // Bin-style process entrypoint (signal wiring + process.exit + the
        // not-yet-wired store/driver TODO). Not meaningfully unit-testable
        // in-process; worker.ts carries the real behavior and is fully
        // covered. Same house pattern as packages/inngest-functions
        // excluding its untested plugin.*.ts functions.
        "src/main.ts",
      ],
      thresholds: { lines: 90, branches: 81, functions: 90, statements: 90 },
    },
  },
});
