import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { INK, INK_TOKENS, lineTones } from "./theme.mjs";

/** The kit's tokens as this repo vendors them (sync-brand-assets.mjs). */
const KIT = JSON.parse(
  readFileSync(
    new URL(
      "../../../../packages/ui/src/styles/house-tokens.json",
      import.meta.url,
    ),
    "utf8",
  ),
).tokens;

describe("INK", () => {
  it("is the house ink palette, byte for byte", () => {
    expect(INK.ground).toBe("#09090B");
    expect(INK.panel).toBe("#18181B");
    expect(INK.line).toBe("#27272A");
    expect(INK.text).toBe("#FFFFFF");
    expect(INK.gold).toBe("#D4AF37");
  });

  // #3074: the literals above passed while INK.dim sat at #52525B and the kit
  // said #71717A. Every value is read against the vendored kit tokens, so a
  // drift fails here even on a machine with no kit checkout.
  it.each(Object.keys(INK))("%s matches the kit token it is named for", (key) => {
    const token = INK_TOKENS[key];
    expect(token, `INK_TOKENS has no entry for ${key}`).toBeTypeOf("string");
    expect(INK[key]).toBe(KIT[token]);
  });

  it("maps no token the kit does not define", () => {
    expect(Object.keys(INK_TOKENS).sort()).toEqual(Object.keys(INK).sort());
    for (const token of Object.values(INK_TOKENS)) {
      expect(KIT[token], token).toMatch(/^#[0-9A-F]{6}$/);
    }
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
