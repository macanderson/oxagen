// INV-22 (ARCHITECTURE.md §4, §5): no demo, seed or mock data and no dev-only
// data or auth switch exists under `apps/app`. The runtime fixture adapter,
// its `MC_DATA` selector, the `mc_state` switch and the fixture session left
// in WL-04; this test keeps them out by scanning every file under `src/`,
// plus `instrumentation.ts` and `next.config.ts`, for the tokens that named
// them and for `E2E_TEST`, whose one sanctioned reader lives in packages/auth.
// Test files are scanned too: a test that stubs the switch is the switch's
// first way back in.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { APP_DIR, listFiles } from "./parse";

const RULE = "fixture-tokens";

/** The tokens, each as the substring INV-22 names. */
const TOKENS: readonly string[] = [
  "MC_DATA",
  "isFixtureMode",
  "FIXTURE_",
  "mc_state",
  "adapters/fixture",
  "E2E_TEST",
];

/** This file names the tokens as data; the probes exist to carry them. */
const SELF = "src/test/arch/fixture-tokens.test.ts";
const PROBES = "src/test/arch/probes/";

/** The scanned set: every file under `src/` but the probes and this test, plus the two app-root modules. */
function scannedFiles(): string[] {
  return [
    ...listFiles("src").filter(
      (file) => file !== SELF && !file.startsWith(PROBES),
    ),
    "instrumentation.ts",
    "next.config.ts",
  ];
}

/** `fixture-tokens <file>:<line> <token>` for every line of every file that carries a token. */
function tokenHits(files: readonly string[]): string[] {
  const hits: string[] = [];
  for (const file of files) {
    const lines = readFileSync(path.join(APP_DIR, file), "utf8").split("\n");
    lines.forEach((line, index) => {
      for (const token of TOKENS) {
        if (line.includes(token))
          hits.push(`${RULE} ${file}:${String(index + 1)} ${token}`);
      }
    });
  }
  return hits;
}

describe("fixture tokens", () => {
  it("no file under src/, instrumentation.ts or next.config.ts carries one", () => {
    expect(tokenHits(scannedFiles())).toEqual([]);
  });

  it("a probe reading MC_DATA fails; a clean probe passes", () => {
    expect(tokenHits([`${PROBES}fixture-tokens/switch.ts`])).toEqual([
      `${RULE} ${PROBES}fixture-tokens/switch.ts:3 MC_DATA`,
    ]);
    expect(tokenHits([`${PROBES}fixture-tokens/clean.ts`])).toEqual([]);
  });

  it("the scan covers the two app-root modules and skips itself and the probes", () => {
    const files = scannedFiles();
    expect(files).toContain("instrumentation.ts");
    expect(files).toContain("next.config.ts");
    expect(files).not.toContain(SELF);
    expect(files.some((file) => file.startsWith(PROBES))).toBe(false);
  });
});
