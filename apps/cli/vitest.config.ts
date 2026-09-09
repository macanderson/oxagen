import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    clearMocks: true,
    environment: "node",
    globals: false,
    // Pin truecolor so any ANSI the CLI emits renders identically everywhere
    // (GitHub Actions runners and local non-TTY shells otherwise downgrade to
    // 16 colors and exact-output assertions fail).
    env: { FORCE_COLOR: "3" },
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    coverage: {
      provider: "v8",
      // `.tsx` stays in the pattern so a future component is gated rather than
      // ungated; the CLI currently ships none.
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.test.tsx",
        // The bin entrypoint: it parses argv, calls main(), and prints a fatal
        // error. Nothing here is unit-drivable — it is exercised by running the
        // binary — and counting it only drags the pool down by its own length.
        "src/index.ts",
      ],
      thresholds: {
        // ONE glob, matching src/** exactly, so nothing is ungated. No
        // top-level (global) numbers: vitest counts glob-matched files in the
        // global pool too, which would double-gate the same population.
        //
        // Ratchet state after the ADR-043 runtime excision (actual: 86.6%
        // lines/statements, 89.3% branches, 94.8% functions). Branches moved
        // 80 -> 86 and functions 85 -> 90 (the cap) on the new numbers, each
        // keeping the required >=2.5% headroom below actual. Lines/statements
        // stay at 84: floor(86.6 - 2.5) is 84, so the bar is already where the
        // ratchet allows. `program.ts` (the command tree) sits near 75% and is
        // what holds the line pool down — raising it is tracked as issue 2587.
        "src/**/*.{ts,tsx}": {
          lines: 84,
          branches: 86,
          functions: 90,
          statements: 84,
        },
      },
    },
  },
});
