"use client";
import * as React from "react";

/**
 * Breakpoint used by `useIsMobile()`. Matches everything below Tailwind's
 * `sm`/`md` phone cutoff (stock Tailwind v4 `md` = 768px).
 */
export const MOBILE_BREAKPOINT_QUERY = "(max-width: 767px)";

/**
 * SSR-safe reactive `matchMedia` hook.
 *
 * Built on `useSyncExternalStore` so it:
 * - returns `false` during SSR and the hydration render (server snapshot),
 *   then re-renders with the real match state — no hydration mismatch;
 * - subscribes to `change` events so the value tracks viewport/orientation
 *   changes live;
 * - degrades to `false` in environments without `window.matchMedia`
 *   (e.g. jsdom test runs that don't stub it).
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = React.useCallback(
    (onStoreChange: () => void) => {
      if (
        typeof window === "undefined" ||
        typeof window.matchMedia !== "function"
      ) {
        return () => {};
      }
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onStoreChange);
      return () => mql.removeEventListener("change", onStoreChange);
    },
    [query],
  );
  const getSnapshot = React.useCallback(() => {
    if (
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function"
    ) {
      return false;
    }
    return window.matchMedia(query).matches;
  }, [query]);
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Stable server snapshot: media queries can never match during SSR. */
function getServerSnapshot(): boolean {
  return false;
}

/**
 * `true` on phone-width viewports (`max-width: 767px`). `false` during
 * SSR/first paint — mobile layouts appear right after hydration.
 */
export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_BREAKPOINT_QUERY);
}
