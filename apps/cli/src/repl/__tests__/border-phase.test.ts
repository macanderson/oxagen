/**
 * Unit tests for the prompt input's turn-lifecycle border animation: the
 * telemetry-phase -> border-phase state machine, the rainbow flash cycle, and
 * the phase+tick -> color resolution. No Ink, no timers — see border-phase.ts's
 * own doc comment for why this is pure.
 */
import { describe, it, expect } from "vitest";
import {
  borderPhaseFor,
  borderColorFor,
  promptBorderColorFor,
  rainbowColorAt,
  RAINBOW_FLASH_COLORS,
  RAINBOW_FLASH_INTERVAL_MS,
  type BorderPhase,
} from "../border-phase.js";
import { theme } from "../../tui/theme.js";
import type { TelemetryTurn } from "../telemetry.js";

describe("borderPhaseFor", () => {
  it("maps idle to idle", () => {
    expect(borderPhaseFor("idle")).toBe("idle");
  });

  it("maps complete (the turn that just ended) to idle, same as idle itself", () => {
    expect(borderPhaseFor("complete")).toBe("idle");
  });

  it("maps evaluate (submit through the coordinator's completeness check) to evaluating", () => {
    expect(borderPhaseFor("evaluate")).toBe("evaluating");
  });

  it("maps every other in-flight pipeline stage to active", () => {
    const activeStages: TelemetryTurn["phase"][] = [
      "enhance",
      "route",
      "execute",
      "judge",
      "revise",
    ];
    for (const stage of activeStages) {
      expect(borderPhaseFor(stage)).toBe("active");
    }
  });

  it("degrades an unrecognized stage kind to active rather than falling back to idle mid-turn", () => {
    expect(borderPhaseFor("some-future-stage" as TelemetryTurn["phase"])).toBe(
      "active",
    );
  });

  it("follows the full submit -> evaluate -> active -> idle sequence in order", () => {
    const sequence: TelemetryTurn["phase"][] = [
      "idle",
      "evaluate",
      "route",
      "execute",
      "judge",
      "complete",
    ];
    expect(sequence.map(borderPhaseFor)).toEqual([
      "idle",
      "evaluating",
      "active",
      "active",
      "active",
      "idle",
    ]);
  });
});

describe("rainbowColorAt", () => {
  it("cycles red -> fuchsia -> orange in order, then repeats", () => {
    expect(rainbowColorAt(0)).toBe(theme.red);
    expect(rainbowColorAt(1)).toBe(theme.fuchsia);
    expect(rainbowColorAt(2)).toBe(theme.orange);
    expect(rainbowColorAt(3)).toBe(theme.red); // wraps
    expect(rainbowColorAt(4)).toBe(theme.fuchsia);
  });

  it("matches RAINBOW_FLASH_COLORS's own declared order", () => {
    for (let i = 0; i < RAINBOW_FLASH_COLORS.length * 2; i++) {
      expect(rainbowColorAt(i)).toBe(
        RAINBOW_FLASH_COLORS[i % RAINBOW_FLASH_COLORS.length],
      );
    }
  });

  it("never returns undefined for a large or negative tick (modulo stays in range)", () => {
    expect(RAINBOW_FLASH_COLORS).toContain(rainbowColorAt(1_000_003));
    expect(RAINBOW_FLASH_COLORS).toContain(rainbowColorAt(-1));
    expect(RAINBOW_FLASH_COLORS).toContain(rainbowColorAt(-4));
  });
});

describe("RAINBOW_FLASH_INTERVAL_MS", () => {
  it("is within the rapid-flash band (110-130ms)", () => {
    expect(RAINBOW_FLASH_INTERVAL_MS).toBeGreaterThanOrEqual(110);
    expect(RAINBOW_FLASH_INTERVAL_MS).toBeLessThanOrEqual(130);
  });
});

describe("borderColorFor", () => {
  it("idle resolves to theme.cyan regardless of tick", () => {
    expect(borderColorFor("idle", 0)).toBe(theme.cyan);
    expect(borderColorFor("idle", 99)).toBe(theme.cyan);
  });

  it("active resolves to theme.amber (the gold token) regardless of tick", () => {
    expect(borderColorFor("active", 0)).toBe(theme.amber);
    expect(borderColorFor("active", 99)).toBe(theme.amber);
  });

  it("evaluating resolves to the rainbow color for that tick", () => {
    expect(borderColorFor("evaluating", 0)).toBe(theme.red);
    expect(borderColorFor("evaluating", 1)).toBe(theme.fuchsia);
    expect(borderColorFor("evaluating", 2)).toBe(theme.orange);
  });

  it("every phase resolves to a distinct steady-state color (idle vs active never collide)", () => {
    const idlePhase: BorderPhase = "idle";
    const activePhase: BorderPhase = "active";
    expect(borderColorFor(idlePhase, 0)).not.toBe(
      borderColorFor(activePhase, 0),
    );
  });
});

describe("promptBorderColorFor (motion-aware)", () => {
  it("at full motion it delegates to borderColorFor, rainbow flash included", () => {
    for (const phase of ["idle", "active", "evaluating"] as const) {
      for (const tick of [0, 1, 2, 7]) {
        expect(promptBorderColorFor(phase, tick, "full")).toBe(
          borderColorFor(phase, tick),
        );
      }
    }
  });

  it("at reduced motion the evaluating flash is suppressed to the static active amber", () => {
    // Same color for every tick — the border must never animate.
    const colors = new Set(
      [0, 1, 2, 3, 9].map((t) =>
        promptBorderColorFor("evaluating", t, "reduced"),
      ),
    );
    expect(colors).toEqual(new Set([theme.amber]));
  });

  it("at reduced/off motion, idle stays cyan and any in-flight phase reads amber", () => {
    for (const motion of ["reduced", "off"] as const) {
      expect(promptBorderColorFor("idle", 5, motion)).toBe(theme.cyan);
      expect(promptBorderColorFor("evaluating", 5, motion)).toBe(theme.amber);
      expect(promptBorderColorFor("active", 5, motion)).toBe(theme.amber);
    }
  });
});
