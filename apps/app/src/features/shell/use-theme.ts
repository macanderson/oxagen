"use client";
// The client side of the theme: read the stored choice, apply it to <html>,
// persist it, and follow the OS while the choice is "system".
import { useCallback, useEffect, useState } from "react";
import {
  applyTheme,
  readThemeCookie,
  type Theme,
  themeCookieString,
} from "./theme";

const DARK_QUERY = "(prefers-color-scheme: dark)";

/**
 * Swap the theme in one frame. Controls with `transition-colors` would
 * otherwise fade between palettes at their own pace, so for a moment the page
 * mixes both themes (and fails contrast) before it settles.
 */
function swapWithoutTransitions(swap: () => unknown): void {
  const style = document.createElement("style");
  style.textContent = "*,*::before,*::after{transition:none!important}";
  document.head.append(style);
  swap();
  // Force a style and layout flush so the new palette lands while transitions are off.
  document.body.getBoundingClientRect();
  requestAnimationFrame(() => {
    style.remove();
  });
}

export function useTheme(): { theme: Theme; setTheme: (theme: Theme) => void } {
  // The pre-paint script already applied the cookie; this reads the same value.
  const [theme, setThemeState] = useState<Theme>(() =>
    typeof document === "undefined"
      ? "system"
      : readThemeCookie(document.cookie),
  );

  useEffect(() => {
    const mql = window.matchMedia(DARK_QUERY);
    swapWithoutTransitions(() =>
      applyTheme(document.documentElement, theme, mql.matches),
    );
    if (theme !== "system") return;
    const onChange = () => {
      swapWithoutTransitions(() =>
        applyTheme(document.documentElement, "system", mql.matches),
      );
    };
    mql.addEventListener("change", onChange);
    return () => {
      mql.removeEventListener("change", onChange);
    };
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    document.cookie = themeCookieString(next, location.protocol === "https:");
    setThemeState(next);
  }, []);

  return { theme, setTheme };
}
