/**
 * Shared constants for the TUI screenshot-style SVG components.
 *
 * Colors are pulled 1:1 from the CLI's own palette (apps/cli/src/tui/theme.ts)
 * so these SVG re-creations never drift from what the real terminal renders.
 * The window chrome (background, border, traffic lights) matches the docs'
 * `.lp-term` hero terminal (apps/docs/src/app/global.css) so a TUI screen reads
 * as a sibling of the landing-page terminal, not a different design language.
 */

/** The CLI's brand palette — see apps/cli/src/tui/theme.ts. */
export const tuiColors = {
  cyan: "#7CE8F4",
  violet: "#7C5AED",
  green: "#34D399",
  amber: "#FBBF24",
  red: "#F87171",
  pink: "#F472B6",
  blue: "#60A5FA",
  teal: "#2DD4BF",
  indigo: "#818CF8",
  dim: "rgba(255,255,255,0.4)",
  dim2: "rgba(255,255,255,0.28)",
} as const;

/** Glyphs the CLI itself uses — kept identical so a reader can search for them. */
export const tuiGlyphs = {
  ring: "◯", // ◯
  pointer: "❯", // ❯
} as const;

/** Monospace stack — matches every TUI screen's fontFamily requirement. */
export const TUI_MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

/** Terminal-window chrome, matched to `.lp-term` in apps/docs/src/app/global.css. */
export const tuiChrome = {
  background: "#121318",
  backgroundOpacity: 0.94,
  border: "rgba(255,255,255,0.12)",
  titleColor: "rgba(255,255,255,0.4)",
  trafficRed: "#ff5f57",
  trafficAmber: "#febc2e",
  trafficGreen: "#28c840",
  shadowColor: "#FFCB66",
} as const;

/** The CLI version string shown in the banner (apps/cli/package.json). */
export const CLI_VERSION = "0.10.0";
