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
      // Ratcheted after the fenced-attempt worker path landed (measured:
      // lines/statements 91.66, branches 94.11, functions 97.61). Only
      // `branches` moves: it was the one metric below the 90 cap, and 88 sits
      // under both floor(94.11 − 2.5) and the cap, so the gate keeps headroom
      // for environment noise. lines/statements/functions are already at or
      // above 90, so their floor is 90 and stays there.
      thresholds: { lines: 90, branches: 88, functions: 90, statements: 90 },
    },
  },
});
