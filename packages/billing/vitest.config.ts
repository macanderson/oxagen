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
      // Measured 2026-09-17 on this package's full run: statements 87.43,
      // branches 89.05, functions 88.65, lines 87.43. The ratchet is
      // floor(measured - 2.5), so the gate keeps at least 2.5 points of
      // headroom and CI does not fail on environment noise.
      //   branches  floor(86.55) = 86, raised from 80.
      //   functions floor(86.15) = 86, raised from 70.
      //   lines/statements floor(84.93) = 84, which is below the 85 already
      //   here — a threshold never goes down, so both stay at 85.
      //
      // #3157 re-measured the same four floors against CI on its own head —
      // 88.12 lines / 89.26 branches / 88.94 functions / 88.12 statements (run
      // 35209437350, job 105170921452) — and floor(CI - 2.5) lands on the same
      // 85/86/86/85, so the two readings agree on the gate. They are set from
      // the instrument the gate actually runs on: CI. They were briefly 90
      // here, calibrated against a LOCAL reading of 93.18 taken before the
      // WL-52 cutover merged in modules this package does not yet cover. Local
      // and CI disagree on this package in both directions and by different
      // magnitudes, so a local reading does not set a floor.
      thresholds: {
        lines: 85,
        branches: 86,
        functions: 86,
        statements: 85,
      },
    },
  },
});
