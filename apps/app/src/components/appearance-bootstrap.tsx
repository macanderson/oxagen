/**
 * AppearanceBootstrap — pre-paint cookie → <html> attribute sync for the
 * Cache Components (PPR) era.
 *
 * With `cacheComponents: true` the root layout is prerendered into a static
 * shell at build time, so it can no longer read the appearance cookies
 * (`theme`, `pref-font-size`, `pref-density`) server-side — per-request
 * attributes on <html> are structurally incompatible with a prerendered
 * shell. Instead the shell renders neutral defaults (no theme class,
 * data-font-size="medium", data-density="comfortable") and this inline
 * script, embedded in the static shell itself, applies the user's stored
 * preferences before first paint. No flash: the browser executes a classic
 * inline script synchronously during HTML parsing, before painting the
 * content that follows it.
 *
 * React 19.2 note: the old @oxagen/ui guidance ("no inline <script>") targets
 * CLIENT-rendered executable scripts, which React replaces with a <div>. This
 * script is emitted by a Server Component into the prerendered HTML stream,
 * so the browser's parser — not React — executes it. Hydration leaves it
 * inert (dangerouslySetInnerHTML content matches), and `suppressHydrationWarning`
 * on <html> covers the attribute delta.
 *
 * Semantics mirror the old server-side reads exactly:
 *   - theme:   "light" | "dark" → class + color-scheme; "system"/absent → no
 *     class (CSS `@media (prefers-color-scheme)` resolves it — see
 *     @oxagen/ui theme-config).
 *   - pref-font-size: "small" | "large" override; "medium" is the default.
 *   - pref-density:  "compact" | "spacious" override; "comfortable" default.
 * Invalid values are ignored, matching parseTheme/parseFontSize/parseDensity.
 *
 * ThemeProvider adopts the cookie in a mount effect (its documented
 * no-initialTheme mode), so React state converges with what this script
 * applied — no flash, no mismatch.
 */
import { THEME_COOKIE_NAME } from "@oxagen/ui";

export const FONT_SIZE_COOKIE_NAME = "pref-font-size";
export const DENSITY_COOKIE_NAME = "pref-density";

/**
 * The bootstrap source. Exported for the unit test, which executes it against
 * a stubbed `document` to verify each cookie → attribute mapping.
 */
export const APPEARANCE_BOOTSTRAP_SCRIPT =
  "(function(){try{" +
  "var e=document.documentElement;" +
  "function c(n){var m=document.cookie.match(new RegExp('(?:^|; )'+n+'=([^;]*)'));return m?decodeURIComponent(m[1]):null}" +
  `var t=c('${THEME_COOKIE_NAME}');` +
  "if(t==='light'||t==='dark'){e.classList.add(t);e.style.colorScheme=t}" +
  `var f=c('${FONT_SIZE_COOKIE_NAME}');` +
  "if(f==='small'||f==='large')e.setAttribute('data-font-size',f);" +
  `var d=c('${DENSITY_COOKIE_NAME}');` +
  "if(d==='compact'||d==='spacious')e.setAttribute('data-density',d);" +
  "}catch(r){}})()";

/** Render as the first child of <body> so it runs before any content paints. */
export function AppearanceBootstrap() {
  return (
    <script
      // eslint-disable-next-line react/no-danger -- deliberate: pre-paint
      // appearance bootstrap must be a classic inline script (see docblock).
      dangerouslySetInnerHTML={{ __html: APPEARANCE_BOOTSTRAP_SCRIPT }}
    />
  );
}
