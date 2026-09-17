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
      // #3157: measured by CI on this head at 88.12 lines / 89.26 branches /
      // 88.94 functions / 88.12 statements (run 35209437350, job
      // 105170921452). Each floor is floor(CI measured - 2.5), so the gate
      // keeps at least 2.5 points of headroom under environment noise, and no
      // floor is ever set below the value already on main (85/80/70/85).
      //
      // lines/statements stay at main's 85 rather than rising: floor(88.12-2.5)
      // is 85, which is the floor already in force, so this branch does not
      // ratchet them. They were briefly 90 here, calibrated against a LOCAL
      // reading of 93.18 taken before the WL-52 cutover merged in modules this
      // package does not yet cover. Local and CI disagree on this package in
      // both directions and by different magnitudes, so the floors are set from
      // the instrument the gate actually runs on: CI.
      thresholds: {
        lines: 85,
        branches: 86,
        functions: 86,
        statements: 85,
      },
    },
  },
});
