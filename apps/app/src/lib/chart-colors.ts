"use client";

/**
 * Theme-resolved colours for the chart surfaces.
 *
 * Every chart in the app used to carry its own private array of hex literals
 * plus its own copy of a `useDarkMode()` hook — four separate palettes that
 * belonged to no theme, so they all survived a brand change untouched and drifted
 * from the product around them. This module is the single place a chart gets a
 * colour, and it reads the real design tokens.
 *
 * WHY RESOLVE AT RUNTIME instead of importing hexes: the tokens live in
 * `@oxagen/ui`'s value layer as `oklch()`, they differ per theme, and the theme
 * can flip at any moment (the `.dark` / `.light` class on the root, or the
 * system preference when neither is set). Reading them from the DOM means a
 * chart re-skins with everything else and cannot drift.
 *
 * WHY NORMALISE TO `rgb()`: reaviz hands `colorScheme` to SVG fills and does its
 * own colour maths on the values. Rather than ship an oklch→rgb converter, the
 * browser does it: set the custom property on a hidden probe element and read
 * back `getComputedStyle().color`, which every engine normalises to `rgb()`.
 *
 * The fallbacks are the LIGHT-theme values of the same tokens. They are only
 * used before the first effect runs and on a server render; charts here are all
 * client-only, so in practice they are the pre-hydration frame.
 */

import { useEffect, useState } from "react";

/** Categorical series ramp — the theme's `--chart-1..5`. */
export const CHART_SERIES_TOKENS = [
  "--chart-1",
  "--chart-2",
  "--chart-3",
  "--chart-4",
  "--chart-5",
] as const;

/** Light-theme values of `--chart-1..5`, for the pre-hydration frame. */
export const CHART_SERIES_FALLBACK = [
  "#EFC53F", // ember  — the brand gold
  "#4E6A7A", // slate  — the cool counterpoint (was the retired indigo #4C51A8)
  "#2F7D4F", // moss
  "#CA6719", // ochre
  "#777782", // silver — achromatic fifth series
] as const;

/**
 * One colour per token, as a TUPLE of the same arity as the token list.
 *
 * This matters: the workspace runs `noUncheckedIndexedAccess`, so a plain
 * `string[]` would make every `colors[0]` a `string | undefined` and push a
 * non-null assertion into each chart. Keying the result to the token tuple
 * keeps indexing exact at the call sites.
 */
type ColorsFor<T extends readonly string[]> = {
  -readonly [K in keyof T]: string;
};

/**
 * The fallback tuple, same arity but READ-ONLY — call sites declare theirs with
 * `as const`, and a mutable parameter type would reject them.
 */
type FallbacksFor<T extends readonly string[]> = {
  readonly [K in keyof T]: string;
};

/**
 * Resolve a list of CSS custom properties to concrete `rgb()` strings.
 * Returns the matching fallback for any token that does not resolve.
 */
export function resolveThemeColors<T extends readonly string[]>(
  tokens: T,
  fallbacks: FallbacksFor<T>,
): ColorsFor<T> {
  const fallbackAt = (i: number): string =>
    (fallbacks as readonly string[])[i] ?? "#000000";
  if (typeof document === "undefined" || !document.body) {
    return tokens.map((_, i) => fallbackAt(i)) as ColorsFor<T>;
  }
  const probe = document.createElement("span");
  probe.style.display = "none";
  document.body.appendChild(probe);
  try {
    return tokens.map((token, i) => {
      probe.style.color = "";
      probe.style.color = `var(${token})`;
      return getComputedStyle(probe).color || fallbackAt(i);
    }) as ColorsFor<T>;
  } finally {
    probe.remove();
  }
}

/**
 * The given design tokens as `rgb()` strings, recomputed whenever the active
 * theme flips. Pass the token names, not colours:
 *
 *   const [ok, bad] = useThemeColors(["--success", "--destructive"] as const, ["#2F7D4F", "#DC2828"]);
 */
export function useThemeColors<T extends readonly string[]>(
  tokens: T,
  fallbacks: FallbacksFor<T>,
): ColorsFor<T> {
  const [colors, setColors] = useState<ColorsFor<T>>(
    () =>
      tokens.map(
        (_, i) => (fallbacks as readonly string[])[i] ?? "#000000",
      ) as ColorsFor<T>,
  );
  // The token list is a module-level constant at every call site; join it so a
  // fresh array literal per render cannot restart the effect on every render.
  const key = tokens.join(",");
  useEffect(() => {
    const root = document.documentElement;
    const refresh = () => setColors(resolveThemeColors(tokens, fallbacks));
    refresh();
    const observer = new MutationObserver(refresh);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", refresh);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", refresh);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the
    // stable identity of `tokens`; `fallbacks` is a constant at every call site.
  }, [key]);
  return colors;
}

/** The categorical series ramp, theme-resolved. Five slots, in token order. */
export function useChartSeriesColors(): ColorsFor<typeof CHART_SERIES_TOKENS> {
  return useThemeColors(CHART_SERIES_TOKENS, CHART_SERIES_FALLBACK);
}
