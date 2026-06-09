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
      // lines floor 68 (measured 73.81 pre-plugins-epic); target 75
      // branches floor 64 (measured 69.51); target 70
      // functions floor 33 (v8 arrow-attribution on rollup-usage + barrels
      //   drag it down; this floor matches reality, NOT a regression).
      // Raise all three via dedicated handler tests once plugins epic stabilises.
      thresholds: {
        lines: 68,
        branches: 64,
        functions: 33,
        statements: 68,
      },
    },
  },
});
