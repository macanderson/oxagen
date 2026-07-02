// The Oxagen brand palette. Single source of truth shared by every TUI surface
// (banner, menu, forms) and the `oxagen dev` status view.
export const theme = {
  cyan: "#7CE8F4", // jewel cyan — ring glyph, accents
  violet: "#7C5AED", // jewel violet — wordmark, selection
  dim: "gray",
  ring: "◯",
  pointer: "❯",
  // Status colors — shared by every activity surface via tui/activity.ts
  // (previously each of hud.tsx / fleet-view / best-of-n-view spelled these
  // out independently as a mix of hex and CSS color names).
  green: "#34D399", // done / success
  amber: "#FBBF24", // queued / caution
  red: "#F87171", // failed / destructive
} as const;
