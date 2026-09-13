import { describe, expect, it } from "vitest";
import { INK, lineTones } from "./theme.mjs";

describe("INK", () => {
  it("is the house ink palette, byte for byte", () => {
    expect(INK.ground).toBe("#10100F");
    expect(INK.panel).toBe("#181715");
    expect(INK.line).toBe("#292722");
    expect(INK.text).toBe("#F2EEE5");
    expect(INK.gold).toBe("#D6962C");
  });

  it("has no paper surface: every generated image is on ink", () => {
    // paper (#F2EEE5) is the text tone here, never a ground or a panel
    expect(INK.ground).not.toBe("#F2EEE5");
    expect(Object.values(INK)).not.toContain("#F8F5EE");
    expect(Object.isFrozen(INK)).toBe(true);
  });

  it("offers three stroke tones, quietest first, none of them a hairline of the ground", () => {
    const tones = lineTones();
    expect(tones).toEqual([INK.dim, INK.muted, INK.body]);
    expect(lineTones(INK)).toEqual(tones);
    expect(tones).not.toContain(INK.line);
  });
});
