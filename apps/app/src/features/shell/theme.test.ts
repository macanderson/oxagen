// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyTheme,
  nextTheme,
  parseTheme,
  readThemeCookie,
  resolveTheme,
  THEME_SCRIPT,
  themeCookieString,
} from "./theme";

function resetRoot() {
  const root = document.documentElement;
  delete root.dataset.theme;
  root.classList.remove("light", "dark");
  root.style.colorScheme = "";
  document.cookie = "theme=; Max-Age=0; Path=/";
}

afterEach(() => {
  resetRoot();
  vi.unstubAllGlobals();
});

describe("theme values", () => {
  it("accepts the three themes and defaults anything else to system", () => {
    expect(parseTheme("light")).toBe("light");
    expect(parseTheme("dark")).toBe("dark");
    expect(parseTheme("system")).toBe("system");
    expect(parseTheme("sepia")).toBe("system");
    expect(parseTheme(undefined)).toBe("system");
  });

  it("resolves system against the OS preference", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
  });

  it("cycles light → dark → system → light", () => {
    expect(nextTheme("light")).toBe("dark");
    expect(nextTheme("dark")).toBe("system");
    expect(nextTheme("system")).toBe("light");
  });

  it("reads the theme cookie among others", () => {
    expect(readThemeCookie("a=1; theme=dark; b=2")).toBe("dark");
    expect(readThemeCookie("theme=light")).toBe("light");
    expect(readThemeCookie("mytheme=dark")).toBe("system");
    expect(readThemeCookie("")).toBe("system");
  });

  it("writes a year-long, lax cookie, secure only over https", () => {
    expect(themeCookieString("dark", false)).toBe(
      "theme=dark; Path=/; Max-Age=31536000; SameSite=Lax",
    );
    expect(themeCookieString("light", true)).toMatch(/; Secure$/);
  });
});

describe("applyTheme", () => {
  it("sets data-theme and the kit class for an explicit choice", () => {
    const root = document.documentElement;
    expect(applyTheme(root, "dark", false)).toBe("dark");
    expect(root.dataset.theme).toBe("dark");
    expect(root.classList.contains("dark")).toBe(true);
    expect(root.style.colorScheme).toBe("dark");
  });

  it("removes data-theme for system and follows the OS for the class", () => {
    const root = document.documentElement;
    applyTheme(root, "light", false);
    applyTheme(root, "system", true);
    expect(root.dataset.theme).toBeUndefined();
    expect(root.classList.contains("dark")).toBe(true);
    expect(root.classList.contains("light")).toBe(false);
  });
});

describe("THEME_SCRIPT", () => {
  const run = () => {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- executes the exact pre-paint string under test
    new Function(THEME_SCRIPT)();
  };

  it("applies the stored theme before paint, like applyTheme", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    document.cookie = "theme=dark; Path=/";
    run();
    const root = document.documentElement;
    expect(root.dataset.theme).toBe("dark");
    expect(root.classList.contains("dark")).toBe(true);
  });

  it("follows the OS when no theme is stored", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    run();
    const root = document.documentElement;
    expect(root.dataset.theme).toBeUndefined();
    expect(root.classList.contains("dark")).toBe(true);
  });

  it("never throws when matchMedia is unavailable", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(run).not.toThrow();
  });
});
