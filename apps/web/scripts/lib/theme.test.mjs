import { describe, expect, it } from "vitest";
import { blockTones, lineTones, theme, THEMES } from "./theme.mjs";

describe("theme", () => {
  it("has a dark and a light palette on the house tokens", () => {
    expect(THEMES).toEqual(["dark", "light"]);
    expect(theme("dark").ground).toBe("#10100F");
    expect(theme("light").ground).toBe("#F2EEE5");
    expect(theme("dark").gold).toBe("#D6962C");
    expect(theme("light").goldText).toBe("#8B5E1A");
  });

  it("rejects an unknown theme", () => {
    expect(() => theme("sepia")).toThrow(/unknown theme/);
  });

  it("offers three hairline tones and two block tones per theme", () => {
    for (const name of THEMES) {
      expect(lineTones(theme(name))).toHaveLength(3);
      expect(blockTones(theme(name))).toHaveLength(2);
    }
  });
});
