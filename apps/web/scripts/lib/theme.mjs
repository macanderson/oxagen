// The house palette for generated images, byte-for-byte off
// oxagen-house-brand/tokens/house-tokens.json (the same table assets/oxagen.css
// holds). Ink only: the site is ink, and an ink image sits well on paper
// where a paper image on paper washes out, so there is no light rendering.
// Gold is identity: a generated image spends it on the one gold dot in a
// panel's title bar and the wordmark's x, never as a surface or decoration.
// No gradients anywhere.

export const INK = Object.freeze({
  ground: "#09090B",
  panel: "#18181B",
  raised: "#27272A",
  line: "#27272A",
  rule: "#3F3F46",
  dim: "#52525B",
  muted: "#A1A1AA",
  silver: "#A1A1AA",
  body: "#E4E4E7",
  text: "#FFFFFF",
  gold: "#D4AF37",
});

/**
 * The stroke tones a drawing may use, quietest first: a hairline that
 * recedes, the working line, and the one accent that reads as the figure.
 */
export function lineTones(t = INK) {
  return [t.dim, t.muted, t.body];
}
