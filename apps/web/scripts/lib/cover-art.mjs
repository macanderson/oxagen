// Generative cover art for blog posts.
//
// Every post gets its own image instead of five posts sharing one licensed
// stock photo per pillar. The art is a hex-lattice mosaic in the Oxagen
// house brand: an ink ground, flat tonal blocks and hairline rings for
// depth (no gradients — see assets/oxagen.css), and gold used exactly once
// per cover as the identity accent, never as decoration. The hex cell is
// the brand's own shape (see oxagen-house-brand/build/marks.py CELL and
// this site's own .tex-hex texture in assets/oxagen.css), scaled up into a
// one-off poster composition.
//
// Deterministic: the same slug always renders the same cover, so a post's
// image is stable across rebuilds and reviewable in a diff. A post's
// pillar nudges the composition's personality (scale, density, tilt) so
// posts under one pillar read as kin without being identical.

const INK = "#10100F"; // --st-bg
const BLOCK_TONES = ["#181715", "#201F1C"]; // --st-panel, --st-hl
const RING_TONES = ["#292722", "#34322D", "#504C44"]; // --st-border, --st-rule, --st-dim
const GOLD = "#D6962C"; // --st-gold — identity and at most one action per screen

const W = 1600;
const H = 900;

// pointy-top hex, the brand mark's proportions (marks.py CELL = (6.30, 6.64))
const CELL_ASPECT = 6.64 / 6.3;

const PILLAR_PERSONALITY = {
  ontologies: { scale: 0.78, density: 0.52, tilt: 4 },
  "ai-agents": { scale: 1.0, density: 0.42, tilt: -3 },
  "coding-agents": { scale: 0.85, density: 0.48, tilt: 0 },
  "self-improving-models": { scale: 1.15, density: 0.34, tilt: 8 },
  "self-evolving-agents": { scale: 1.25, density: 0.3, tilt: -7 },
};
const DEFAULT_PERSONALITY = { scale: 1.0, density: 0.4, tilt: 0 };

/** @param {string} str */
function hash32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** @param {number} seed */
function mulberry32(seed) {
  let a = seed;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** @param {number} cx @param {number} cy @param {number} rx @param {number} ry */
function hexPoints(cx, cy, rx, ry) {
  return [
    [cx, cy - ry],
    [cx + rx, cy - ry / 2],
    [cx + rx, cy + ry / 2],
    [cx, cy + ry],
    [cx - rx, cy + ry / 2],
    [cx - rx, cy - ry / 2],
  ]
    .map((p) => p.join(","))
    .join(" ");
}

/** @param {(...args: unknown[]) => number} rand @param {string[]} list */
function pick(rand, list) {
  return list[Math.floor(rand() * list.length)];
}

/**
 * @param {{ slug: string, pillar: string }} o slug seeds the composition;
 *   pillar (the post's primary/first pillar) sets its personality band
 * @returns {string} a self-contained 1600x900 SVG document
 */
export function coverSvg({ slug, pillar }) {
  const rand = mulberry32(hash32(slug));
  const personality = PILLAR_PERSONALITY[pillar] ?? DEFAULT_PERSONALITY;

  // jitter the pillar's personality per post so siblings are kin, not clones
  const scale = personality.scale * (0.85 + rand() * 0.3);
  const rx = 62 * scale;
  const ry = rx * CELL_ASPECT;
  const pitchX = rx * 1.03;
  const pitchY = ry * 1.545;
  const tilt = personality.tilt + (rand() - 0.5) * 6;

  const cx0 = W / 2;
  const cy0 = H / 2;

  // oversize the lattice so the tilt never exposes bare canvas at a corner;
  // the root <svg> clips anything outside its viewBox
  const pad = Math.max(rx, ry) * 3;
  const cols = Math.ceil((W + pad * 2) / pitchX) + 2;
  const rows = Math.ceil((H + pad * 2) / pitchY) + 2;
  const originX = -pad;
  const originY = -pad;

  const cells = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const cx = originX + col * pitchX + (row % 2 ? pitchX / 2 : 0);
      const cy = originY + row * pitchY;
      // normalised distance from canvas centre, rotation-invariant since we
      // rotate the whole lattice about (cx0, cy0)
      const dist = Math.hypot((cx - cx0) / (W / 2), (cy - cy0) / (H / 2));
      cells.push({ cx, cy, dist });
    }
  }

  // exactly one solid-gold cell: the identity accent, never more than one.
  // Restricted to a safe inner radius so the tilt can never carry it off
  // the visible canvas.
  const safe = cells.filter((c) => c.dist < 0.72);
  const goldCell = safe[Math.floor(rand() * safe.length)];

  const shapes = [];
  for (const cell of cells) {
    const isGold = cell === goldCell;
    const edgeFalloff =
      personality.density * (1 - Math.min(cell.dist, 1) ** 1.6);
    if (!isGold && rand() >= edgeFalloff) continue;
    const pts = hexPoints(cell.cx, cell.cy, rx, ry);
    if (isGold) {
      shapes.push(`<polygon points="${pts}" fill="${GOLD}"/>`);
    } else if (rand() < 0.62) {
      shapes.push(
        `<polygon points="${pts}" fill="${pick(rand, BLOCK_TONES)}"/>`,
      );
    } else {
      shapes.push(
        `<polygon points="${pts}" fill="none" stroke="${pick(rand, RING_TONES)}" stroke-width="1.6"/>`,
      );
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="overflow:hidden">
  <rect width="${W}" height="${H}" fill="${INK}"/>
  <g transform="rotate(${tilt.toFixed(2)} ${cx0} ${cy0})">
${shapes.join("\n")}
  </g>
</svg>
`;
}
