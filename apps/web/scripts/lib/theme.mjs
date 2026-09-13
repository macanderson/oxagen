// The house palette for generated images, byte-for-byte off
// oxagen-house-brand/tokens/house-tokens.json (the same table assets/oxagen.css
// holds). Ink only: the site is ink, and an ink image sits well on paper
// where a paper image on paper washes out, so there is no light rendering.
// Gold is identity: a generated image spends it on the one gold dot in a
// panel's title bar and the wordmark's x, never as a surface or decoration.
// No gradients anywhere.

export const INK = Object.freeze({
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
});

/**
 * The stroke tones a drawing may use, quietest first: a hairline that
 * recedes, the working line, and the one accent that reads as the figure.
 */
export function lineTones(t = INK) {
  return [t.dim, t.muted, t.body];
}
