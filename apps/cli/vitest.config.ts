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
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.test.tsx",
        // The bin entrypoint: it parses argv, calls main(), and prints a fatal
        // error. Nothing here is unit-drivable — it is exercised by running the
        // binary — and counting it only drags the pool down by its own length.
        "src/index.ts",
      ],
      thresholds: {
        // No top-level (global) numbers: vitest counts glob-matched files in the
        // global pool too, which would blend the .ts ratchet with the .tsx floor.
        // The two globs below partition src/** exactly, so nothing is ungated.
        // The .ts gate keeps the ratchet global carried before .tsx was measured.
        // ONE glob now, not two. The `.tsx` half gated a population of Ink
        // components that the Stella cutover deleted along with the REPL; what
        // remained under that glob was the command tree alone, and a
        // component floor is not a meaningful gate for it. `.tsx` stays in the
        // pattern so a future component is gated rather than ungated.
        //
        // Lines/statements moved 85 -> 84 because the SUBJECT changed, not the
        // discipline: `program.ts` (the ~2.4k-line command tree) has always sat
        // near 75%, and the large, well-tested REPL used to carry the average
        // above it. Raising it back is tracked, not forgotten — see the issue
        // tracked as issue 2587. Branches and functions are UNCHANGED and
        // still clear their old bars.
        "src/**/*.{ts,tsx}": {
          lines: 84,
          branches: 80,
          functions: 85,
          statements: 84,
        },
      },
    },
  },
});
