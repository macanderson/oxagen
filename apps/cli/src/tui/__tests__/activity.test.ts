/**
 * Proves the shared activity vocabulary — the one status→glyph/color mapping
 * that /hud, the fleet roster, and the best-of-N lane view all resolve
 * through — and its plain-text formatter for non-Ink surfaces (one-shot).
 */
import { describe, it, expect } from "vitest";
import {
  activityGlyph,
  formatActivityLine,
  type ActivityStatus,
} from "../activity.js";
import { theme } from "../theme.js";

describe("activityGlyph", () => {
  it("gives every status its own glyph + color", () => {
    expect(activityGlyph("queued")).toEqual({ glyph: "⧗", color: theme.amber });
    expect(activityGlyph("blocked")).toEqual({ glyph: "⊘", color: theme.red });
    expect(activityGlyph("cancelled")).toEqual({
      glyph: "⊘",
      color: theme.dim,
    });
    expect(activityGlyph("done")).toEqual({ glyph: "✓", color: theme.green });
    expect(activityGlyph("failed")).toEqual({ glyph: "✗", color: theme.red });
  });

  it("blocked and cancelled share a glyph but differ in color (distinguishable at a glance)", () => {
    const blocked = activityGlyph("blocked");
    const cancelled = activityGlyph("cancelled");
    expect(blocked.glyph).toBe(cancelled.glyph);
    expect(blocked.color).not.toBe(cancelled.color);
  });

  it("running renders a static bullet when no frame is given (HUD's non-animated style)", () => {
    expect(activityGlyph("running")).toEqual({ glyph: "●", color: theme.cyan });
  });

  it("running animates a braille spinner across frames when a frame counter is given", () => {
    const f0 = activityGlyph("running", 0);
    const f1 = activityGlyph("running", 1);
    expect(f0.color).toBe(theme.cyan);
    expect(f0.glyph).not.toBe("●");
    expect(f1.glyph).not.toBe(f0.glyph);
  });

  it("wraps the spinner frame index so any frame counter is safe", () => {
    const f0 = activityGlyph("running", 0);
    const f10 = activityGlyph("running", 10); // 10 frames in SPINNER_FRAMES → wraps to 0
    expect(f10).toEqual(f0);
  });

  it("verifying looks identical to running (same spinner, same color)", () => {
    expect(activityGlyph("verifying", 3)).toEqual(activityGlyph("running", 3));
    expect(activityGlyph("verifying")).toEqual(activityGlyph("running"));
  });

  it("covers every ActivityStatus without a default fallback (exhaustive switch)", () => {
    const statuses: ActivityStatus[] = [
      "queued",
      "running",
      "verifying",
      "blocked",
      "cancelled",
      "done",
      "failed",
    ];
    for (const status of statuses) {
      const g = activityGlyph(status);
      expect(g.glyph.length).toBeGreaterThan(0);
      expect(g.color.length).toBeGreaterThan(0);
    }
  });
});

describe("formatActivityLine", () => {
  it("renders the label alone when there is no detail", () => {
    expect(formatActivityLine({ label: "editing…" })).toBe("editing…");
  });

  it("joins label and detail with a middle dot", () => {
    expect(
      formatActivityLine({ label: "editing…", detail: "src/foo.ts" }),
    ).toBe("editing… · src/foo.ts");
  });

  it("omits the dot entirely for an empty-string detail", () => {
    expect(formatActivityLine({ label: "done", detail: "" })).toBe("done");
  });

  it("composes directly with a StageEvent-shaped object (kind + label + detail)", () => {
    // No adapter object needed — a StageEvent (kind/label/detail) satisfies
    // the { label, detail? } shape structurally.
    const stageLike = {
      kind: "execute",
      label: "running the agent",
      detail: "step 4",
    };
    expect(formatActivityLine(stageLike)).toBe("running the agent · step 4");
  });
});
