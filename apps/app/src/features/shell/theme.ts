// Theme: light, dark or system (spec: the mockup's "Paper", "Ink" and "Match
// the system").
//
// The choice is written to `<html data-theme>` (absent for system, as in the
// mockup) and to the house kit's `light`/`dark` class, which is what
// @oxagen/ui's tokens key on; for system the class follows the OS preference so
// `dark:` utilities still resolve. The choice persists in the kit's `theme`
// cookie, which the pre-paint script reads before first paint.

export type Theme = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEMES: readonly Theme[] = ["system", "light", "dark"];

/** The house kit's cookie name (@oxagen/ui THEME_COOKIE_NAME), so both agree. */
export const THEME_COOKIE = "theme";
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

export function parseTheme(value: string | null | undefined): Theme {
  return value === "light" || value === "dark" || value === "system"
    ? value
    : "system";
}

export function resolveTheme(theme: Theme, systemDark: boolean): ResolvedTheme {
  if (theme === "system") return systemDark ? "dark" : "light";
  return theme;
}

/** The user menu's "Switch theme" order, from the mockup: light → dark → system → light. */
export function nextTheme(theme: Theme): Theme {
  if (theme === "light") return "dark";
  if (theme === "dark") return "system";
  return "light";
}

export function readThemeCookie(cookie: string): Theme {
  const match = /(?:^|;\s*)theme=([^;]*)/.exec(cookie);
  return parseTheme(match?.[1]);
}

export function themeCookieString(theme: Theme, secure: boolean): string {
  return `${THEME_COOKIE}=${theme}; Path=/; Max-Age=${String(ONE_YEAR_SECONDS)}; SameSite=Lax${secure ? "; Secure" : ""}`;
}

type ThemeTarget = {
  dataset: DOMStringMap;
  classList: Pick<DOMTokenList, "add" | "remove">;
  style: Pick<CSSStyleDeclaration, "colorScheme">;
};

/** Reflect a theme onto the root element. */
export function applyTheme(
  root: ThemeTarget,
  theme: Theme,
  systemDark: boolean,
): ResolvedTheme {
  const resolved = resolveTheme(theme, systemDark);
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
  root.classList.remove("light", "dark");
  root.classList.add(resolved);
  root.style.colorScheme = resolved;
  return resolved;
}

/**
 * The pre-paint script: the same rules as `applyTheme`, inlined so it runs
 * before React hydrates and the page never flashes the wrong theme.
 */
export const THEME_SCRIPT = `(function(){try{var m=/(?:^|;\\s*)theme=(light|dark|system)/.exec(document.cookie);var t=m?m[1]:"system";var d=document.documentElement;var r=t==="system"?(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):t;if(t==="system"){delete d.dataset.theme}else{d.dataset.theme=t}d.classList.remove("light","dark");d.classList.add(r);d.style.colorScheme=r}catch(e){}})();`;
