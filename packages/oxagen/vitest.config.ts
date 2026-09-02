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
      // Ratcheted after plugins phase 1 (manifest + registry + kernel gate).
      // Measured 95.39 lines / 84.12 branches / 88.67 functions. Thresholds only go up.
      //
      // HEADROOM WARNING: the repo rule (CLAUDE.md "Test gate enforcement") is to
      // leave at least 2.5 points between the measured coverage and the gate, so
      // ordinary run-to-run noise cannot fail CI. These gates leave 0.39 (lines and
      // statements), 0.12 (branches) and 0.67 (functions) — far tighter than that.
      // Do NOT lower them (the ratchet only goes up); the correct fix is to add
      // tests until the measurement clears each gate by 2.5, at which point these
      // numbers can be re-ratcheted to floor(measured - 2.5) and this note removed.
      thresholds: {
        lines: 95,
        branches: 84,
        functions: 88,
        statements: 95,
      },
    },
  },
});
