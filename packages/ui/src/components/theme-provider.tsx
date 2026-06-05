"use client";
/**
 * ThemeProvider / useTheme — self-hosted, class-based theming for all Oxagen
 * Next.js apps. Vendor-neutral replacement for `next-themes`, which renders its
 * bootstrap <script> from a client component and trips React 19.2's
 * "script tag while rendering React component" error on Next 16
 * (pacocoursey/next-themes#385, #387 — open/unfixed).
 *
 * Split of responsibilities:
 *   - {@link ThemeProvider} (this file, "use client") owns React state, the
 *     `setTheme` setter, system-preference + cross-tab sync, and applying the
 *     resolved theme class to <html>. It renders NO <script>.
 *   - {@link ThemeScript} (server component, ./theme-script) emits the
 *     render-blocking no-flash bootstrap. Render it once in the root layout.
 *
 * Usage (root layout — a Server Component):
 *   import { ThemeProvider } from "@oxagen/ui";
 *   import { ThemeScript } from "@oxagen/ui/components/theme-script";
 *   ...
 *   <body>
 *     <ThemeScript />
 *     <ThemeProvider>{children}</ThemeProvider>
 *   </body>
 *
 * Keep <html suppressHydrationWarning> on the layout: the bootstrap script
 * mutates <html>'s class before hydration, so its attributes legitimately
 * differ from the server-rendered markup.
 */
import * as React from "react";

export type Theme = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export interface ThemeContextValue {
  /** The user's selection, including "system". */
  theme: Theme;
  /** The concrete theme in effect — "system" resolved against the OS preference. */
  resolvedTheme: ResolvedTheme;
  /** Persist and apply a new selection. */
  setTheme: (theme: Theme) => void;
  /** All selectable values. */
  themes: Theme[];
}

const ThemeContext = React.createContext<ThemeContextValue | undefined>(undefined);

const MEDIA = "(prefers-color-scheme: dark)";
const THEMES: Theme[] = ["light", "dark", "system"];

function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined") return "light";
  return window.matchMedia(MEDIA).matches ? "dark" : "light";
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
  /** localStorage key for the persisted preference. Must match ThemeScript. */
  storageKey?: string;
  /** Theme to use before anything is persisted. Must match ThemeScript. */
  defaultTheme?: Theme;
  /** Set `color-scheme` on <html> alongside the class. */
  enableColorScheme?: boolean;
  /** Suppress CSS transitions during the swap to avoid a color flash. */
  disableTransitionOnChange?: boolean;
}

export function ThemeProvider({
  children,
  storageKey = "theme",
  defaultTheme = "system",
  enableColorScheme = true,
  disableTransitionOnChange = true,
}: ThemeProviderProps) {
  const [theme, setThemeState] = React.useState<Theme>(defaultTheme);
  const [systemTheme, setSystemTheme] = React.useState<ResolvedTheme>(getSystemTheme);

  // Adopt the persisted preference on mount (client-only; SSR uses defaultTheme).
  React.useEffect(() => {
    try {
      const stored = localStorage.getItem(storageKey) as Theme | null;
      if (stored && THEMES.includes(stored)) setThemeState(stored);
    } catch {
      // localStorage unavailable (private mode / SSR) — keep defaultTheme.
    }
  }, [storageKey]);

  const resolvedTheme: ResolvedTheme = theme === "system" ? systemTheme : theme;

  // Reflect the resolved theme onto <html>.
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

  // Keep tabs in sync.
  React.useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== storageKey) return;
      const next = e.newValue as Theme | null;
      setThemeState(next && THEMES.includes(next) ? next : defaultTheme);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [storageKey, defaultTheme]);

  const setTheme = React.useCallback(
    (next: Theme) => {
      setThemeState(next);
      try {
        localStorage.setItem(storageKey, next);
      } catch {
        // Persist is best-effort; in-memory state still updates.
      }
    },
    [storageKey],
  );

  const value = React.useMemo<ThemeContextValue>(
    () => ({ theme, resolvedTheme, setTheme, themes: THEMES }),
    [theme, resolvedTheme, setTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = React.useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme must be used within a <ThemeProvider>");
  }
  return ctx;
}
