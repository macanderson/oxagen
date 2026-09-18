import { describe, expect, it } from "vitest";
import { INK, lineTones } from "./theme.mjs";

describe("INK", () => {
  it("is the house ink palette, byte for byte", () => {
    expect(INK.ground).toBe("#09090B");
    expect(INK.panel).toBe("#18181B");
    expect(INK.line).toBe("#27272A");
    expect(INK.text).toBe("#FFFFFF");
    expect(INK.gold).toBe("#D4AF37");
  });

  it("has no paper surface: every generated image is on ink", () => {
    // white (#FFFFFF) is the text tone here, never a ground or a surface
    for (const surface of [INK.ground, INK.panel, INK.raised]) {
      expect(surface).not.toBe("#FFFFFF");
    }
    expect(Object.isFrozen(INK)).toBe(true);
  });

  it("offers three stroke tones, quietest first, none of them a hairline of the ground", () => {
    const tones = lineTones();
    expect(tones).toEqual([INK.dim, INK.muted, INK.body]);
    expect(lineTones(INK)).toEqual(tones);
    expect(tones).not.toContain(INK.line);
  });
});
