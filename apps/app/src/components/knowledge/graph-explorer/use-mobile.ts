/**
 * use-mobile.ts — viewport/input-capability media-query hooks for the graph
 * explorer's responsive behaviour.
 *
 * Local to the graph explorer (there is no shared app-wide hook yet). Built on
 * `useSyncExternalStore` so the value is SSR-safe (server snapshot is `false`,
 * i.e. desktop-first) and updates live on orientation/viewport changes.
 * Defensive against environments without `window.matchMedia` (older jsdom,
 * SSR) — those report `false`.
 */

"use client";

import * as React from "react";

/** Below Tailwind `lg` (1024px) — the explorer's mobile/compact-panel cutoff. */
const MOBILE_QUERY = "(max-width: 1023px)";
/** Below Tailwind `md` (768px) — the toolbar's collapsed-actions cutoff. */
const COMPACT_QUERY = "(max-width: 767px)";
/** True only for pointer-fine devices that support real hover (not touch). */
const HOVER_QUERY = "(hover: hover)";

function canMatchMedia(): boolean {
  return (
    typeof window !== "undefined" && typeof window.matchMedia === "function"
  );
}

export function useMediaQuery(query: string): boolean {
  const subscribe = React.useCallback(
    (onChange: () => void) => {
      if (!canMatchMedia()) return () => {};
      const mql = window.matchMedia(query);
      // Older WebKit exposes only addListener/removeListener.
      if (typeof mql.addEventListener === "function") {
        mql.addEventListener("change", onChange);
        return () => mql.removeEventListener("change", onChange);
      }
      mql.addListener(onChange);
      return () => mql.removeListener(onChange);
    },
    [query],
  );

  const getSnapshot = React.useCallback(
    () => (canMatchMedia() ? window.matchMedia(query).matches : false),
    [query],
  );

  return React.useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/** True below `lg` — detail/filter panels move into bottom sheets. */
export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_QUERY);
}

/** True below `md` — toolbar icon actions collapse into a "More" menu. */
export function useIsCompact(): boolean {
  return useMediaQuery(COMPACT_QUERY);
}

/** True when the device supports real hover (pointer-fine, not touch). */
export function useHasHover(): boolean {
  return useMediaQuery(HOVER_QUERY);
}
