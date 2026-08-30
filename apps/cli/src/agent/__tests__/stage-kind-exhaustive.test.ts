/**
 * Guards against StageKind drift between the engine and the CLI.
 *
 * `StageKind` used to be hand-copied in apps/cli/src/agent/trace.ts, separate
 * from the canonical union in packages/agent-engine/src/trace/types.ts. The two
 * lists could (and did, structurally) drift apart with no compiler signal,
 * because a plain string-literal union re-declaration doesn't fail to compile
 * just because it stopped matching another file's union — it's simply wrong at
 * runtime the moment the engine emits a stage the CLI never learned about.
 *
 * trace.ts now re-exports `StageKind` from `@oxagen/agent-engine` instead of
 * redefining it, so there is exactly one place the union lives. This file
 * proves that:
 *   1. trace.ts is a re-export, not a redefinition (a source guard: if someone
 *      reintroduces a hand-copied union, this test fails immediately).
 *   2. Every render map keyed by StageKind (PHASE_LABEL here; the Ink-facing
 *      STAGE_GLYPH/STAGE_COLOR/STAGE_LABEL maps are covered in
 *      repl/__tests__/components.test.tsx) has an entry for every known stage,
 *      so a newly added StageKind member can't silently fall through to
 *      `undefined` in the UI.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { PHASE_LABEL } from "../trace-format.js";
import type { StageKind } from "../trace.js";

const traceTsPath = fileURLToPath(new URL("../trace.ts", import.meta.url));

/**
 * Every stage the pipeline is known to emit today, in execution order. Keep in
 * sync with the canonical union in packages/agent-engine/src/trace/types.ts —
 * if that union grows, add the new member here AND to every Record<StageKind, ...>
 * map; TypeScript will already refuse to compile those maps without it, and the
 * membership assertion below will fail until this list is updated too.
 */
const KNOWN_STAGE_KINDS: readonly StageKind[] = [
  "evaluate",
  "plan",
  "enhance",
  "route",
  "execute",
  "judge",
  "revise",
  "complete",
];

describe("StageKind source of truth", () => {
  it("trace.ts re-exports StageKind from @oxagen/agent-engine instead of redefining it", () => {
    const source = readFileSync(traceTsPath, "utf8");
    // StageKind is re-exported from the engine barrel — alone or bundled with the
    // other trace interfaces in one `export type { … } from "@oxagen/agent-engine"`.
    expect(source).toMatch(
      /export type \{[^}]*\bStageKind\b[^}]*\}\s*from\s*"@oxagen\/agent-engine"/s,
    );
    // Guard against a future hand-copied union reappearing alongside the
    // re-export (the exact drift this test suite exists to catch).
    expect(source).not.toMatch(/export type StageKind\s*=/);
  });
});

describe("PHASE_LABEL exhaustiveness", () => {
  it("has a human label for every known StageKind", () => {
    for (const kind of KNOWN_STAGE_KINDS) {
      expect(PHASE_LABEL[kind]).toBeTruthy();
      expect(typeof PHASE_LABEL[kind]).toBe("string");
    }
  });

  it("exposes exactly the known stage kinds — no stragglers, none missing", () => {
    expect(Object.keys(PHASE_LABEL).sort()).toEqual(
      [...KNOWN_STAGE_KINDS].sort(),
    );
  });
});
