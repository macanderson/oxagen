import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    clearMocks: true,
    environment: "node",
    globals: false,
    // Ink/chalk pick a color depth from the environment at import time, and the
    // slash-menu tests assert exact truecolor ANSI sequences. Pin truecolor so
    // rendering is deterministic everywhere (GitHub Actions runners and local
    // non-TTY shells otherwise downgrade to 16 colors and the assertions fail).
    env: { FORCE_COLOR: "3" },
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    coverage: {
      provider: "v8",
      // .tsx is measured too — an excluded-from-coverage component is exactly
      // how the unmounted-HudPanel class of bug stays invisible. Ink components
      // are harder to unit-drive than plain .ts, so they gate against their own
      // per-glob floor below instead of the .ts ratchet.
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: ["src/**/*.test.ts", "src/**/*.test.tsx"],
      thresholds: {
        // No top-level (global) numbers: vitest counts glob-matched files in the
        // global pool too, which would blend the .ts ratchet with the .tsx floor.
        // The two globs below partition src/** exactly, so nothing is ungated.
        // The .ts gate keeps the ratchet global carried before .tsx was measured.
        "src/**/*.ts": {
          lines: 85,
          branches: 80,
          functions: 85,
          statements: 85,
        },
        // Measured 2026-07-08 at 60.4 l / 76.5 b / 79.2 f / 60.4 s (with main's
        // known-failing suites depressing it), gated with the standard 2.5
        // headroom. Ratchet upward only — never lower, never past 90.
        "src/**/*.tsx": {
          lines: 57,
          branches: 73,
          functions: 76,
          statements: 57,
        },
      },
    },
  },
});
