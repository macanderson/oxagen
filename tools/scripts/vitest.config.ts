import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    clearMocks: true,
    environment: "node",
    globals: false,
    include: ["*.test.ts"],
    // The one package in the repo whose coverage nothing enforced. Every other
    // vitest config here declares thresholds — 36 of 37 — and the exception was
    // this one, which holds the guards that decide whether anything else may
    // merge: `env-check.ts`, `scr-dod-check.mjs`, `check_manifest.mjs`,
    // `check-dod-stub-parity.mjs`, `check-infra-doc-paths.mjs`,
    // `ensure-e2e-failure-ticket.ts`. `test:coverage` ran and reported a number
    // that could not fail, so the guard code was the least-guarded code here.
    //
    // These are a floor, not a target. They are the measured values less the
    // 2.5 points of headroom CLAUDE.md's ratchet asks for, so CI cannot go red
    // on environment noise, and they only ever move up. Statements and lines
    // sit near 29 because most files in this directory are operator scripts
    // with no test at all; the number is low on purpose rather than aspirational,
    // because a threshold nobody can meet gets lowered, and a lowered ratchet is
    // no ratchet.
    coverage: {
      thresholds: {
        statements: 26,
        branches: 82,
        functions: 49,
        lines: 26,
      },
    },
  },
});
