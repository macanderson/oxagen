// The house palette for generated images, byte-for-byte off
// oxagen-house-brand/tokens/house-tokens.json (the same table assets/oxagen.css
// holds). Two grounds, the warm greys between, and one metal. Gold is identity:
// a generated image uses it for exactly one honeycomb cell and the wordmark's
// x, never as a surface or decoration. No gradients anywhere.

export const THEMES = ["dark", "light"];

const DARK = {
  name: "dark",
  ground: "#10100F",
  panel: "#181715",
  raised: "#201F1C",
  line: "#292722",
  rule: "#34322D",
  dim: "#504C44",
  muted: "#8C877C",
  silver: "#9B958A",
  body: "#DDD8CD",
  text: "#F2EEE5",
  gold: "#D6962C",
  goldText: "#D6962C",
};

const LIGHT = {
  name: "light",
  ground: "#F2EEE5",
  panel: "#F8F5EE",
  raised: "#D8CDBD", // the kit has no second light panel; its hairline tone is the nearest opaque step
  line: "#D8CDBD",
  rule: "#C9BFAE",
  dim: "#8C877C",
  muted: "#6B665C",
  silver: "#6B665C",
  body: "#2A2823",
  text: "#10100F",
  gold: "#D6962C",
  goldText: "#8B5E1A",
};

/** @param {"dark"|"light"} name */
export function theme(name) {
  if (name === "dark") return DARK;
  if (name === "light") return LIGHT;
  throw new Error(`unknown theme "${name}"`);
}

/** The tones a hairline drawing may use on a theme, quietest first. */
export function lineTones(t) {
  return [t.line, t.rule, t.dim];
}

/** The tones a flat block may use on a theme. */
export function blockTones(t) {
  return [t.panel, t.raised];
}
