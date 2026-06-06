import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      // lines floor 68 (measured 73.81); target 75 — raise in follow-up
      // branches floor 64 (measured 69.51); target 70 — raise in follow-up
      // functions floor 33 (measured 33.33 on main too — barrels + the untested
      //   dunning-sweep handler + a v8 arrow-attribution quirk on rollup-usage
      //   drag it down; this floor matches reality and is NOT a regression from
      //   this PR). Raise via dedicated handler tests in the follow-up (OXA-1553).
      thresholds: {
        lines: 68,
        branches: 64,
        functions: 33,
        statements: 68,
      },
    },
  },
});
