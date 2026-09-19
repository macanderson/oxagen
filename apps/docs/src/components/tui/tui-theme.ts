/**
 * Shared constants for the TUI screenshot-style SVG components.
 *
 * These are house colours. The file used to carry Tailwind's default nine-hue
 * palette under a comment saying it was pulled 1:1 from the CLI's own palette
 * at apps/cli/src/tui/theme.ts — a file that does not exist, so nothing was
 * being kept in step and an off-system palette shipped on every screenshot on
 * the docs site. Each stop below is the kit's state colour on ink (the bare
 * --ox-st-* value; the terminal is always dark), so a state here means the same
 * thing it means in the app.
 *
 * An SVG attribute cannot read a custom property that the surrounding page may
 * not have in scope, so the values are literal. They are transcribed from
 * packages/ui/src/styles/house-tokens.css and each names its token.
 *
 * The window chrome matches the docs' `.lp-term` hero terminal
 * (apps/docs/src/app/global.css) so a TUI screen reads as a sibling of the
 * landing-page terminal, not a different design language.
 */

/** The house state ramp, on ink. Keys are the roles the screens ask for. */
export const tuiColors = {
  cyan: "#3FA2A2", // --ox-st-proven: the witness's word
  violet: "#5B93D6", // --ox-st-approval: routed to a person
  green: "#57A97C", // --ox-st-allowed: a rule allowed it
  amber: "#C66A4A", // --ox-st-denied: a rule denied it
  red: "#C0453C", // --ox-st-failed: a check that did not hold
  pink: "#D6455E", // --ox-st-critical: needs a person now
  blue: "#5B93D6", // --ox-st-approval
  teal: "#3FA2A2", // --ox-st-proven
  indigo: "#5B93D6", // --ox-st-approval
  dim: "rgba(255,255,255,0.4)",
  dim2: "rgba(255,255,255,0.28)",
} as const;

/** Glyphs the CLI itself uses — kept identical so a reader can search for them. */
export const tuiGlyphs = {
  ring: "◯", // ◯
  pointer: "❯", // ❯
} as const;

/**
 * The house code face, which is the one the real terminal renders in. The kit
 * gives code, logs and ids to Monaspace Neon; the rest of the stack is the
 * fallback from --ox-font-mono.
 */
export const TUI_MONO =
  '"Monaspace Neon", ui-monospace, "SF Mono", Menlo, Consolas, monospace';

/** Terminal-window chrome, matched to `.lp-term` in apps/docs/src/app/global.css. */
export const tuiChrome = {
  background: "#18181B",
  backgroundOpacity: 0.94,
  border: "rgba(255,255,255,0.12)",
  titleColor: "rgba(255,255,255,0.4)",
  // The window buttons, on the house ramp rather than macOS's own three.
  trafficRed: "#C0453C", // --ox-st-failed
  trafficAmber: "#C66A4A", // --ox-st-denied
  trafficGreen: "#57A97C", // --ox-st-allowed
  shadowColor: "#F1CE65",
} as const;

/** The CLI version string shown in the banner (apps/cli/package.json). */
export const CLI_VERSION = "2.1.1";
