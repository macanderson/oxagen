/**
 * Theme configuration shared by the server (root layout) and the client
 * {@link ThemeProvider}.
 *
 * This module deliberately has NO "use client" directive — it is server-safe so
 * a Server Component layout can read the theme cookie and render the resolved
 * class straight onto `<html>`. Server-rendering the class is what lets us drop
 * the inline no-flash `<script>` entirely: there is no React-rendered executable
 * `<script>` to trip React 19.2's "Encountered a script tag while rendering React
 * component" warning, and no FOUC because the class is already in the SSR HTML.
 *
 * Source of truth is a cookie (not localStorage) precisely so the server can see
 * it. `"system"` is represented as the *absence* of a class — CSS
 * `@media (prefers-color-scheme)` drives those colors (see styles/globals.css),
 * so a static page that never reads the cookie still themes correctly with no
 * flash.
 */

export type Theme = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEMES: readonly Theme[] = ["light", "dark", "system"];

/**
 * Cookie the preference is persisted to. NOT HttpOnly — the client toggle reads
 * and writes it, and the server reads it during layout render.
 */
export const THEME_COOKIE_NAME = "theme";

/** One year. The preference is durable across sessions. */
export const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** Narrow an arbitrary cookie value to a {@link Theme}, defaulting to "system". */
export function parseTheme(value: string | null | undefined): Theme {
  return value === "light" || value === "dark" || value === "system"
    ? value
    : "system";
}

/**
 * The class to place on `<html>` for a given preference.
 *  - "light" / "dark" → an explicit class (force, overriding the OS preference).
 *  - "system" → `""` (no class); CSS `@media (prefers-color-scheme)` resolves it
 *    with no flash, so callers need not read the cookie to render correctly.
 */
export function themeClass(theme: Theme): "" | "light" | "dark" {
  return theme === "system" ? "" : theme;
}
