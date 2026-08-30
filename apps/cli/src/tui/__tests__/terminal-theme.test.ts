import { describe, it, expect } from "vitest";
import {
  detectTerminalBackground,
  diffThemeFor,
  DARK_DIFF_THEME,
  LIGHT_DIFF_THEME,
} from "../terminal-theme.js";

describe("detectTerminalBackground", () => {
  it("honors an explicit OXAGEN_TERMINAL_BG override before anything else", () => {
    expect(
      detectTerminalBackground({
        OXAGEN_TERMINAL_BG: "light",
        COLORFGBG: "15;0",
      }),
    ).toBe("light");
    expect(
      detectTerminalBackground({
        OXAGEN_TERMINAL_BG: "dark",
        COLORFGBG: "0;15",
      }),
    ).toBe("dark");
  });

  it("ignores an unrecognized OXAGEN_TERMINAL_BG value and falls through to COLORFGBG", () => {
    expect(
      detectTerminalBackground({
        OXAGEN_TERMINAL_BG: "auto",
        COLORFGBG: "0;15",
      }),
    ).toBe("light");
  });

  it("parses COLORFGBG '15;0' (dark background index) as dark", () => {
    expect(detectTerminalBackground({ COLORFGBG: "15;0" })).toBe("dark");
  });

  it("parses COLORFGBG '0;15' (light background index) as light", () => {
    expect(detectTerminalBackground({ COLORFGBG: "0;15" })).toBe("light");
  });

  it("parses COLORFGBG '1;7' (light background index) as light", () => {
    expect(detectTerminalBackground({ COLORFGBG: "1;7" })).toBe("light");
  });

  it("takes the last field of a three-part 'fg;default;bg' COLORFGBG", () => {
    expect(detectTerminalBackground({ COLORFGBG: "15;default;0" })).toBe(
      "dark",
    );
    expect(detectTerminalBackground({ COLORFGBG: "0;default;15" })).toBe(
      "light",
    );
  });

  it("falls back to dark when neither env var is set", () => {
    expect(detectTerminalBackground({})).toBe("dark");
  });

  it("falls back to dark on malformed COLORFGBG", () => {
    expect(detectTerminalBackground({ COLORFGBG: "not-a-number" })).toBe(
      "dark",
    );
    expect(detectTerminalBackground({ COLORFGBG: "" })).toBe("dark");
    expect(detectTerminalBackground({ COLORFGBG: ";" })).toBe("dark");
  });

  it("falls back to dark on an out-of-range COLORFGBG index", () => {
    expect(detectTerminalBackground({ COLORFGBG: "0;99" })).toBe("dark");
  });
});

describe("diffThemeFor", () => {
  it("returns distinct light and dark themes", () => {
    expect(diffThemeFor("dark")).toBe(DARK_DIFF_THEME);
    expect(diffThemeFor("light")).toBe(LIGHT_DIFF_THEME);
    expect(diffThemeFor("dark")).not.toEqual(diffThemeFor("light"));
  });

  it("gives each theme a full, distinctly-colored palette", () => {
    for (const theme of [DARK_DIFF_THEME, LIGHT_DIFF_THEME]) {
      expect(theme.add).toBeTruthy();
      expect(theme.addEmphasis).toBeTruthy();
      expect(theme.del).toBeTruthy();
      expect(theme.delEmphasis).toBeTruthy();
      expect(theme.hunk).toBeTruthy();
      expect(theme.meta).toBeTruthy();
      expect(theme.context).toBeTruthy();
      expect(theme.lineNumber).toBeTruthy();
      expect(theme.highlightjs).toBeTruthy();
    }
    expect(DARK_DIFF_THEME.add).not.toBe(LIGHT_DIFF_THEME.add);
    expect(DARK_DIFF_THEME.del).not.toBe(LIGHT_DIFF_THEME.del);
  });
});
