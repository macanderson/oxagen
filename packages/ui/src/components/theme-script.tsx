/**
 * ThemeScript — render-blocking, no-flash theme bootstrap.
 *
 * This MUST remain a Server Component (no "use client" directive). It is
 * deliberately separated from `theme-provider.tsx` so that the `<script>`
 * element is only ever produced during server rendering. React 19.2 (shipped
 * with Next 16) emits a console error — "Encountered a script tag while
 * rendering React component" — whenever a *client* component renders a
 * `<script>`, because client-rendered scripts never execute. `next-themes`
 * renders its bootstrap script from inside its client provider and so trips
 * that warning on Next 16 (upstream pacocoursey/next-themes#385, #387, both
 * open/unfixed). Emitting the script from a Server Component sidesteps the
 * warning entirely: a Server Component never hydrates, so React never
 * re-renders this node on the client.
 *
 * Render it once, as early as possible (first child of <body>), alongside the
 * client `ThemeProvider`. The inline IIFE applies the persisted/system theme to
 * <html> before first paint, eliminating the flash of incorrect theme.
 */

export interface ThemeScriptProps {
  /** localStorage key the theme preference is read from. Must match ThemeProvider. */
  storageKey?: string;
  /** Theme to assume when nothing is persisted. Must match ThemeProvider. */
  defaultTheme?: "light" | "dark" | "system";
  /** Also set `color-scheme` on <html> so native form controls/scrollbars match. */
  enableColorScheme?: boolean;
  /** CSP nonce, forwarded to the inline <script>. */
  nonce?: string;
}

export function ThemeScript({
  storageKey = "theme",
  defaultTheme = "system",
  enableColorScheme = true,
  nonce,
}: ThemeScriptProps) {
  // Self-contained IIFE — no closure over module scope, runs before hydration.
  const script = `(function(){try{var d=document.documentElement;var s=localStorage.getItem(${JSON.stringify(
    storageKey,
  )})||${JSON.stringify(
    defaultTheme,
  )};var t=s==="system"?(window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):s;d.classList.remove("light","dark");d.classList.add(t);${
    enableColorScheme ? "d.style.colorScheme=t;" : ""
  }}catch(e){}})();`;

  return (
    <script
      nonce={nonce}
      suppressHydrationWarning
      dangerouslySetInnerHTML={{ __html: script }}
    />
  );
}
