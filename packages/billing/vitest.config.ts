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
      thresholds: {
        lines: 85,
        branches: 86,
        functions: 86,
        statements: 85,
      },
    },
  },
});
