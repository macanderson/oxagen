// The house palette for generated images. Each value is the kit token
// `INK_TOKENS` names, from macanderson/oxagen-brand's tokens/house-tokens.json
// (vendored as packages/ui/src/styles/house-tokens.json).
// `node tools/scripts/sync-brand-assets.mjs` rewrites the values from the kit,
// and its `--check` fails when one drifts (#3074). Ink only: the site is ink,
// and an ink image sits well on paper where a paper image on paper washes out,
// so there is no light rendering.
// Gold is identity: a generated image spends it on the one gold dot in a
// panel's title bar and the wordmark's x, never as a surface or decoration.
// No gradients anywhere.

export const INK = Object.freeze({
  ground: "#09090B",
  panel: "#18181B",
  raised: "#27272A",
  line: "#27272A",
  rule: "#3F3F46",
  dim: "#71717A",
  muted: "#A1A1AA",
  silver: "#A1A1AA",
  body: "#E4E4E7",
  text: "#FFFFFF",
  gold: "#D4AF37",
});

/**
 * The kit token each `INK` key takes its value from. `raised` and `line` are
 * both the kit's hairline grey, and `silver` is its muted grey.
 */
export const INK_TOKENS = Object.freeze({
  ground: "ink",
  panel: "panel",
  raised: "hl",
  line: "border",
  rule: "rule",
  dim: "dim",
  muted: "muted",
  silver: "muted",
  body: "text-body",
  text: "text",
  gold: "gold",
});

/**
 * The stroke tones a drawing may use, quietest first: a hairline that
 * recedes, the working line, and the one accent that reads as the figure.
 */
export function lineTones(t = INK) {
  return [t.dim, t.muted, t.body];
}
