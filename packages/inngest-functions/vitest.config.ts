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
        // Spread vitest defaults first so node_modules, test files, configs,
        // and other standard exclusions are still applied.
        ...coverageConfigDefaults.exclude,

        // Plugin-epic functions (plugin.*.ts): subject to change; no stable
        // interface contract yet. Tracked for testing in Linear OXA-1553.
        "src/functions/plugin.*.ts",

        // Pure barrel/re-export files: zero testable logic — every line is
        // a re-export that is exercised via the modules it imports.
        "src/functions.ts",
        "src/index.ts",
      ],
      // Floors ratcheted up after privacy-pipeline handler tests landed
      // (measured: lines/statements 90.11, branches 86.20, functions 70.00).
      // Bumped conservatively below the floor(coverage − 2.5) ceiling to keep
      // generous headroom — v8 arrow-attribution on rollup-usage + barrels can
      // make the functions metric jittery across Node versions. Raise further
      // once the plugins epic stabilises.
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 50,
        statements: 80,
      },
    },
  },
});
