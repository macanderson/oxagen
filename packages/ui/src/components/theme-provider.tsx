"use client";
/**
 * ThemeProvider / useTheme — self-hosted, class-based theming for all Oxagen
 * Next.js apps. Vendor-neutral replacement for `next-themes`.
 *
 * The preference lives in a cookie ({@link THEME_COOKIE_NAME}). `"system"`
 * renders no class and is resolved by CSS `@media (prefers-color-scheme)`
 * (see styles/globals.css). Two no-flash integration modes:
 *
 *   1. SSR-cookie mode (apps WITHOUT Cache Components): the root layout (a
 *      Server Component) reads the cookie via {@link parseTheme} and renders
 *      the resolved class onto `<html>` directly, then passes it as
 *      `initialTheme`. No inline `<script>` needed.
 *   2. Bootstrap-script mode (apps WITH `cacheComponents: true`, e.g.
 *      apps/app): the root layout is prerendered into a static shell and must
 *      not read cookies, so it renders no theme class and embeds a tiny
 *      SERVER-rendered inline script (see apps/app AppearanceBootstrap) that
 *      applies the cookie's class before first paint. Omit `initialTheme`;
 *      the provider adopts the cookie in a mount effect.
 *
 * Inline-script caveat: React 19.2 (Next 16) replaces CLIENT-rendered
 * executable `<script>` elements with a `<div>` and logs "Encountered a script
 * tag while rendering React component". A script emitted by a Server Component
 * into the initial HTML stream is executed by the browser's parser, not React,
 * so bootstrap-script mode is safe — but never render an executable `<script>`
 * from a client component.
 *
 * Split of responsibilities:
 *   - The root layout (server) establishes the pre-paint class via mode 1 or 2.
 *   - {@link ThemeProvider} (this file, "use client") owns React state, the
 *     `setTheme` setter, system-preference + cross-tab sync, cookie persistence,
 *     and reflecting the resolved class onto `<html>`. It renders NO `<script>`.
 *
 * Usage (SSR-cookie mode root layout — a Server Component):
 *   import { cookies } from "next/headers";
 *   import { ThemeProvider, THEME_COOKIE_NAME, parseTheme, themeClass } from "@oxagen/ui";
 *   export default async function RootLayout({ children }) {
 *     const theme = parseTheme((await cookies()).get(THEME_COOKIE_NAME)?.value);
 *     return (
 *       <html lang="en" className={themeClass(theme)} suppressHydrationWarning>
 *         <body>
 *           <ThemeProvider initialTheme={theme}>{children}</ThemeProvider>
 *         </body>
 *       </html>
 *     );
 *   }
 *
 * Keep `suppressHydrationWarning` on `<html>`: for "system" the provider adds an
 * explicit class on the client after resolving the OS preference, so the class
 * attribute legitimately differs from the (classless) server markup.
 */
import * as React from "react";
import {
  type Theme,
  type ResolvedTheme,
  THEMES,
  THEME_COOKIE_NAME,
  THEME_COOKIE_MAX_AGE,
  parseTheme,
} from "./theme-config";

export interface ThemeContextValue {
  /** The user's selection, including "system". */
  theme: Theme;
  /** The concrete theme in effect — "system" resolved against the OS preference. */
  resolvedTheme: ResolvedTheme;
  /** Persist and apply a new selection. */
  setTheme: (theme: Theme) => void;
  /** All selectable values. */
  themes: readonly Theme[];
}

const ThemeContext = React.createContext<ThemeContextValue | undefined>(
  undefined,
);

const MEDIA = "(prefers-color-scheme: dark)";
/** Cross-tab sync channel — preferred over a localStorage `storage` event so we
 *  keep the cookie as the single persistent store. */
const SYNC_CHANNEL = "oxagen-theme";

function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined") return "light";
  return window.matchMedia(MEDIA).matches ? "dark" : "light";
}

/** Read the theme cookie on the client (the server reads it via next/headers). */
function readThemeCookie(name: string): Theme | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? parseTheme(decodeURIComponent(match[1] ?? "")) : null;
}

/** Persist the preference to a cookie the server can read on the next render. */
function writeThemeCookie(name: string, value: Theme): void {
  if (typeof document === "undefined") return;
  const secure =
    typeof location !== "undefined" && location.protocol === "https:"
      ? "; Secure"
      : "";
  document.cookie = `${name}=${value}; Path=/; Max-Age=${THEME_COOKIE_MAX_AGE}; SameSite=Lax${secure}`;
}

/**
 * Momentarily kill CSS transitions while the theme class swaps, so colors don't
 * animate on switch. Returns a function that re-enables them on the next frame.
 */
function suppressTransitions(): () => void {
  const style = document.createElement("style");
  style.appendChild(
    document.createTextNode(
      "*,*::before,*::after{-webkit-transition:none!important;-moz-transition:none!important;-o-transition:none!important;-ms-transition:none!important;transition:none!important}",
    ),
  );
  document.head.appendChild(style);
  return () => {
    // Force a reflow so the style takes effect before removal.
    window.getComputedStyle(document.body);
    setTimeout(() => document.head.removeChild(style), 1);
  };
}

export interface ThemeProviderProps {
  children: React.ReactNode;
  /**
   * The cookie-resolved preference from the server, so client state matches the
   * SSR-rendered `<html>` class with no hydration mismatch or flash. Omit on
   * static pages that don't read the cookie — the provider falls back to
   * `defaultTheme` and adopts any existing cookie on mount.
   */
  initialTheme?: Theme;
  /** Cookie key for the persisted preference. Must match the layout's read. */
  cookieName?: string;
  /** Theme to assume when no preference is known (no `initialTheme`, no cookie). */
  defaultTheme?: Theme;
  /** Set `color-scheme` on `<html>` alongside the class. */
  enableColorScheme?: boolean;
  /** Suppress CSS transitions during the swap to avoid a color flash. */
  disableTransitionOnChange?: boolean;
}

export function ThemeProvider({
  children,
  initialTheme,
  cookieName = THEME_COOKIE_NAME,
  defaultTheme = "system",
  enableColorScheme = true,
  disableTransitionOnChange = true,
}: ThemeProviderProps) {
  const [theme, setThemeState] = React.useState<Theme>(
    initialTheme ?? defaultTheme,
  );
  const [systemTheme, setSystemTheme] =
    React.useState<ResolvedTheme>(getSystemTheme);

  // When the server didn't pass a preference (static page), adopt any existing
  // cookie on mount. When it did, the cookie already matches — this is a no-op.
  React.useEffect(() => {
    if (initialTheme !== undefined) return;
    const stored = readThemeCookie(cookieName);
    if (stored) setThemeState(stored);
  }, [initialTheme, cookieName]);

  const resolvedTheme: ResolvedTheme = theme === "system" ? systemTheme : theme;

  // Reflect the resolved theme onto <html>. For an explicit cookie this matches
  // the SSR class (idempotent); for "system" it adds the OS-resolved class.
  React.useEffect(() => {
    const restore = disableTransitionOnChange ? suppressTransitions() : null;
    const el = document.documentElement;
    el.classList.remove("light", "dark");
    el.classList.add(resolvedTheme);
    if (enableColorScheme) el.style.colorScheme = resolvedTheme;
    restore?.();
  }, [resolvedTheme, enableColorScheme, disableTransitionOnChange]);

  // Track OS preference changes (only matters while theme === "system").
  React.useEffect(() => {
    const mql = window.matchMedia(MEDIA);
    const onChange = () => setSystemTheme(mql.matches ? "dark" : "light");
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  // Keep other tabs in sync. The cookie is shared across tabs already; this just
  // pushes the in-memory state so open tabs re-render without a reload.
  React.useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(SYNC_CHANNEL);
    const onMessage = (e: MessageEvent) => {
      const next = parseTheme(typeof e.data === "string" ? e.data : undefined);
      setThemeState(next);
    };
    channel.addEventListener("message", onMessage);
    return () => {
      channel.removeEventListener("message", onMessage);
      channel.close();
    };
  }, []);

  const setTheme = React.useCallback(
    (next: Theme) => {
      setThemeState(next);
      writeThemeCookie(cookieName, next);
      if (typeof BroadcastChannel !== "undefined") {
        const channel = new BroadcastChannel(SYNC_CHANNEL);
        channel.postMessage(next);
        channel.close();
      }
    },
    [cookieName],
  );

  const value = React.useMemo<ThemeContextValue>(
    () => ({ theme, resolvedTheme, setTheme, themes: THEMES }),
    [theme, resolvedTheme, setTheme],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

/**
 * Inert context returned by {@link useTheme} when no <ThemeProvider> is found in
 * the tree. The only realistic way to hit this is a dev-mode React Fast Refresh:
 * hot-swapping this "use client" module can momentarily give the already-mounted
 * provider and a freshly re-evaluated consumer two different ThemeContext
 * identities, so `useContext` returns undefined for one render. Throwing there
 * escalates a transient, self-healing state into a full-screen app crash.
 *
 * Falling back to "system"/light with a no-op setter lets that render degrade to
 * a sane default until the next render realigns the identities. `setTheme` is a
 * deliberate no-op: with no provider there is no state to update.
 */
const FALLBACK_THEME: ThemeContextValue = {
  theme: "system",
  resolvedTheme: "light",
  setTheme: () => {},
  themes: THEMES,
};

/**
 * Read the active theme and setter. Intended to be used under a <ThemeProvider>
 * (every Oxagen app mounts one in its root layout). If the provider context is
 * missing it does NOT throw — it returns {@link FALLBACK_THEME} and, in
 * development only, logs a warning. This keeps a transient Fast Refresh context
 * mismatch (or any stray render outside the provider) from crashing the app,
 * while still surfacing a genuinely missing provider to developers.
 */
export function useTheme(): ThemeContextValue {
  const ctx = React.useContext(ThemeContext);
  if (ctx) return ctx;
  if (process.env.NODE_ENV !== "production") {
    console.warn(
      "[useTheme] no <ThemeProvider> ancestor found — returning a default theme. " +
        "This is expected momentarily during a dev Fast Refresh reload; if it " +
        "persists, wrap the tree in <ThemeProvider>.",
    );
  }
  return FALLBACK_THEME;
}
