// Named hex tones pulled out so the slash-command palette below can reuse the
// same values as their corresponding theme keys without drifting out of sync.
const CYAN = "#7CE8F4";
const VIOLET = "#7C5AED";
const GREEN = "#34D399";
const AMBER = "#FBBF24";
const PINK = "#F472B6";
const BLUE = "#60A5FA";
const TEAL = "#2DD4BF";
const INDIGO = "#818CF8";
// Rainbow-flash-only tones (repl/border-phase.ts): the prompt input's border
// cycles through these while a turn's EVALUATE stage is in flight. Deliberately
// punchier/more saturated than `red`/`amber` above (which carry their own
// steady-state meaning — failed/destructive, queued/caution) so a rapid flash
// never reads as an error state or gets confused with the post-evaluate amber.
const FUCHSIA = "#D946EF";
const ORANGE = "#FB923C";

// The Oxagen brand palette. Single source of truth shared by every TUI surface
// (banner, menu, forms) and the `oxagen dev` status view.
export const theme = {
  cyan: CYAN, // jewel cyan — ring glyph, accents
  violet: VIOLET, // jewel violet — wordmark, selection
  dim: "gray",
  ring: "◯",
  pointer: "❯",
  // Status colors — shared by every activity surface via tui/activity.ts,
  // so hud.tsx / fleet-view / best-of-n-view stay in sync.
  green: GREEN, // done / success
  amber: AMBER, // queued / caution
  red: "#F87171", // failed / destructive
  fuchsia: FUCHSIA, // rainbow-flash tone (repl/border-phase.ts) — not a status color
  orange: ORANGE, // rainbow-flash tone (repl/border-phase.ts) — not a status color
  // Curated palette for productized builtin slash commands (see
  // slash/catalog.ts's BUILTIN_SLASH_COMMANDS + repl/slash-menu.tsx). Each
  // builtin command is assigned one tone below, grouped by feature area, so
  // its `/name` renders in a distinct, stable color in the command menu.
  // CLI-sourced and custom commands carry no color and render as default text.
  commandPalette: [CYAN, VIOLET, GREEN, AMBER, PINK, BLUE, TEAL, INDIGO],
} as const;
