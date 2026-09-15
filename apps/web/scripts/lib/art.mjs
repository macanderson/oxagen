// The drawings a generated image is made of.
//
// Three layers. The honeycomb is the brand's own cell (the cluster in
// oxagen-house-brand/build/marks.py, the constellation --tex-hex draws behind
// the hero in oxagen.css). A banner scatters it as a weather of rings and
// flat blocks that clusters differently for every seed, clears around one
// focus and stays quiet on the left, where a page sets its title over it;
// exactly one cell is gold. Round the focus sit hairline halo rings in the
// cell's own shape. At the focus sits one of seven hairline drawings of the
// things the writing is about: a knowledge graph, an ontology, an agent's
// loop, a tool call, a policy gate, an audit ledger, a meter. Hairlines in
// the theme's quiet tones, so a drawing reads as a watermark rather than a
// figure; never a gradient, never a translucent fill. The share card keeps
// the older raised panel, since a card carries its own title.
//
// Everything takes a seeded `rand`, so an image is a pure function of its
// seed and rebuilds identically.

import { textPath } from "./text.mjs";
import { INK, lineTones } from "./theme.mjs";

export const TREATMENTS = [
  "graph",
  "ontology",
  "loop",
  "terminal",
  "gate",
  "ledger",
  "meter",
];

/** What each treatment is a drawing of, for a panel's title bar. */
export const SUBJECTS = {
  graph: "knowledge graph",
  ontology: "ontology",
  loop: "agent loop",
  terminal: "tool call",
  gate: "policy gate",
  ledger: "audit ledger",
  meter: "meter",
};

/** FNV-1a, so a slug picks the same treatment and layout every build. */
export function hash32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** @param {number} seed */
export function prng(seed) {
  let a = seed;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** @param {string} seed */
export function treatmentFor(seed) {
  return TREATMENTS[hash32(`treatment:${seed}`) % TREATMENTS.length];
}

const n = (v) => Number(v.toFixed(1));

// pointy-top hex in the brand mark's proportions (CELL = (6.30, 6.64))
export const CELL_ASPECT = 6.64 / 6.3;

export function hexPoints(cx, cy, rx, ry = rx * CELL_ASPECT) {
  return [
    [cx, cy - ry],
    [cx + rx, cy - ry / 2],
    [cx + rx, cy + ry / 2],
    [cx, cy + ry],
    [cx - rx, cy + ry / 2],
    [cx - rx, cy - ry / 2],
  ]
    .map(([x, y]) => `${n(x)},${n(y)}`)
    .join(" ");
}

// the site's .tex-hex sits under a radial mask that is solid to 60% of the
// way out and gone at the edge; three steps stand in for the mask, so the
// lattice recedes without a gradient. Quieter than the CSS's 0.7, since a
// cover is seen at a fifth of the size the hero is.
const LATTICE_STEPS = [
  [0.6, 0.5],
  [0.85, 0.28],
  [Infinity, 0.1],
];

/**
 * A field of hairline honeycomb cells tiled evenly over a box, fading in
 * steps toward the box's edges. The one place the site's own texture and a
 * generated image share a construction.
 * @param {{ t?: object, x: number, y: number, w: number, h: number, cell: number }} o
 *   cell is a cell's half-width in px
 */
export function lattice(o) {
  const t = o.t ?? INK;
  const rx = o.cell;
  const ry = rx * CELL_ASPECT;
  const pitchX = rx * 2;
  const pitchY = ry * 1.5;
  const cx0 = o.x + o.w / 2;
  const cy0 = o.y + o.h / 2;
  const cols = Math.ceil(o.w / pitchX) + 2;
  const rows = Math.ceil(o.h / pitchY) + 2;
  const bands = LATTICE_STEPS.map(() => []);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const cx = o.x - rx + col * pitchX + (row % 2 ? rx : 0);
      const cy = o.y - ry + row * pitchY;
      const dist = Math.hypot((cx - cx0) / (o.w / 2), (cy - cy0) / (o.h / 2));
      const band = LATTICE_STEPS.findIndex(([edge]) => dist < edge);
      bands[band].push(`<polygon points="${hexPoints(cx, cy, rx, ry)}"/>`);
    }
  }
  return bands
    .map(
      (cells, i) =>
        `<g fill="none" stroke="${t.line}" stroke-width="1" stroke-opacity="${LATTICE_STEPS[i][1]}">${cells.join("")}</g>`,
    )
    .join("");
}

/** The stroke opacities a field cell may take, quietest first. */
export const FIELD_BANDS = [0.22, 0.4, 0.62, 0.9];

/** A value in [0, 1], clamped. */
const unit = (v) => Math.min(1, Math.max(0, v));

/**
 * The honeycomb as weather: every cell of the lattice decides, from a seeded
 * low-frequency wave and its place in the box, whether it is drawn, how
 * loud, and whether it is a hairline ring or a flat block. The wave gives
 * every seed its own clusters; the box's left `quiet` fraction thins out so
 * a title can sit over it; an ellipse round `focus` (half-axes `clear`) is
 * left empty for a drawing, with a ragged edge so the hole reads as
 * weather rather than a cut. One cell beside the clearing is gold, the only
 * gold in the picture.
 * @param {{ rand: () => number, t?: object, x: number, y: number, w: number, h: number,
 *   cell: number, focus: { x: number, y: number }, clear: { x: number, y: number },
 *   quiet?: number }} o cell is a cell's half-width in px
 */
export function field(o) {
  const t = o.t ?? INK;
  const { rand } = o;
  const quiet = o.quiet ?? 0.45;
  const rx = o.cell;
  const ry = rx * CELL_ASPECT;
  const pitchX = rx * 2;
  const pitchY = ry * 1.5;
  const cols = Math.ceil(o.w / pitchX) + 2;
  const rows = Math.ceil(o.h / pitchY) + 2;
  // two waves each way; the frequencies and phases are the seed's
  const k = [
    1.1 + rand() * 1.4,
    0.9 + rand() * 1.4,
    2.0 + rand() * 2.4,
    0.8 + rand() * 1.6,
  ];
  const ph = [rand(), rand(), rand()].map((v) => v * Math.PI * 2);
  const weather = (u, v) =>
    0.5 +
    0.25 *
      Math.sin(u * k[0] * Math.PI + ph[0]) *
      Math.cos(v * k[1] * Math.PI + ph[1]) +
    0.25 * Math.sin(u * k[2] * Math.PI + v * k[3] * Math.PI + ph[2]);
  const rings = FIELD_BANDS.map(() => []);
  const blocks = { [t.line]: [], [t.rule]: [] };
  const candidates = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const cx = o.x - rx + col * pitchX + (row % 2 ? rx : 0);
      const cy = o.y - ry + row * pitchY;
      const u = (cx - o.x) / o.w;
      const v = (cy - o.y) / o.h;
      const wv = weather(u, v);
      const d = Math.hypot(
        (cx - o.focus.x) / o.clear.x,
        (cy - o.focus.y) / o.clear.y,
      );
      // the clearing, with a ragged edge
      if (d < 1 + 0.3 * wv) continue;
      const hush = unit((quiet - u) / quiet);
      // the quiet side thins out; elsewhere the troughs of the wave are empty
      if (wv < 0.42 + 0.3 * hush) continue;
      const near = unit((1.6 - d) / 0.6);
      const points = hexPoints(cx, cy, rx, ry);
      if (d > 1.15 && hush < 0.5) {
        if (d < 1.6 && u > 0.5) candidates.push(points);
        if (wv > 0.76) {
          blocks[wv > 0.87 ? t.rule : t.line].push(points);
          continue;
        }
      }
      const a = (0.22 + 1.6 * (wv - 0.42)) * (1 - 0.6 * hush) + 0.12 * near;
      let band = 0;
      for (let i = 0; i < FIELD_BANDS.length; i++) {
        if (a >= FIELD_BANDS[i]) band = i;
      }
      rings[band].push(points);
    }
  }
  const polys = (cells) =>
    cells.map((p) => `<polygon points="${p}"/>`).join("");
  const out = rings.map(
    (cells, i) =>
      `<g fill="none" stroke="${t.dim}" stroke-width="1.2" stroke-opacity="${FIELD_BANDS[i]}">${polys(cells)}</g>`,
  );
  for (const [fill, cells] of Object.entries(blocks)) {
    out.push(`<g fill="${fill}" stroke="none">${polys(cells)}</g>`);
  }
  if (candidates.length) {
    const gold = candidates[Math.floor(rand() * candidates.length)];
    out.push(`<polygon points="${gold}" fill="${t.gold}" stroke="none"/>`);
  }
  return out.join("");
}

/** The halo rings' scale steps outward from the clearing, and their opacities. */
export const HALO = [
  [1.06, 0.6],
  [1.3, 0.42],
  [1.58, 0.28],
  [1.9, 0.16],
];

/**
 * Hairline rings in the cell's own shape round a focus, stepping outward
 * and fading in hard steps: depth without a gradient.
 * @param {{ t?: object, focus: { x: number, y: number }, clear: { x: number, y: number } }} o
 */
export function halo(o) {
  const t = o.t ?? INK;
  return HALO.map(
    ([k, a]) =>
      `<polygon points="${hexPoints(o.focus.x, o.focus.y, o.clear.x * k, o.clear.x * k * CELL_ASPECT)}" fill="none" stroke="${t.dim}" stroke-width="2" stroke-opacity="${a}"/>`,
  ).join("");
}

export const PANEL_BAR = 56;

/**
 * A raised panel the way the site draws its terminal: a rounded card on a
 * hairline, a title bar with two dim dots and one gold, and a tracked label.
 * Returns the SVG and the box a drawing may fill under the bar.
 * @param {{ t?: object, x: number, y: number, w: number, h: number, label: string, pad?: number }} o
 */
export function panel(o) {
  const t = o.t ?? INK;
  const pad = o.pad ?? 40;
  const bar = o.y + PANEL_BAR;
  const dots = [t.dim, t.dim, t.gold]
    .map(
      (fill, i) =>
        `<circle cx="${n(o.x + 26 + i * 20)}" cy="${n(o.y + PANEL_BAR / 2)}" r="5" fill="${fill}"/>`,
    )
    .join("");
  const svg = [
    `<rect x="${n(o.x)}" y="${n(o.y)}" width="${n(o.w)}" height="${n(o.h)}" rx="12" fill="${t.panel}" stroke="${t.line}" stroke-width="1.5"/>`,
    `<line x1="${n(o.x)}" y1="${n(bar)}" x2="${n(o.x + o.w)}" y2="${n(bar)}" stroke="${t.line}" stroke-width="1.5"/>`,
    dots,
    textPath(o.label.toUpperCase(), {
      x: o.x + 92,
      y: o.y + PANEL_BAR / 2 + 6,
      size: 17,
      weight: 500,
      tracking: 0.16,
      fill: t.muted,
    }),
  ].join("");
  return {
    svg,
    box: {
      x: o.x + pad,
      y: bar + pad * 0.75,
      w: o.w - pad * 2,
      h: o.h - PANEL_BAR - pad * 1.5,
      surface: t.panel,
    },
  };
}

// --------------------------------------------------------------------------
// hairline drawings
// --------------------------------------------------------------------------

/**
 * @param {string} name one of TREATMENTS
 * @param {{ rand: () => number, t?: object, x: number, y: number, w: number, h: number,
 *   surface?: string }} box surface is the fill behind the drawing, which
 *   hollow shapes are punched in; the panel unless told otherwise
 */
export function drawing(name, box) {
  const fn = DRAWINGS[name];
  if (!fn) throw new Error(`unknown treatment "${name}"`);
  const t = box.t ?? INK;
  // the panel is wide, so a drawing sized off its height alone sits small
  // in it; every drawing keeps within 0.8 of its scale vertically, so a
  // fifth over the height still fits
  const s = Math.min(box.w, box.h * 1.2);
  const p = {
    ...box,
    t,
    surface: box.surface ?? t.panel,
    s,
    cx: box.x + box.w / 2,
    cy: box.y + box.h / 2,
    sw: Math.max(1.6, s * 0.006),
    tone: lineTones(t),
  };
  return `<g fill="none" stroke="${p.tone[1]}" stroke-width="${p.sw.toFixed(2)}" stroke-linecap="round" stroke-linejoin="round">${fn(p)}</g>`;
}

const line = (x1, y1, x2, y2, extra = "") =>
  `<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}"${extra}/>`;
const circle = (cx, cy, r, extra = "") =>
  `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}"${extra}/>`;
const rect = (x, y, w, h, extra = "") =>
  `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="2"${extra}/>`;
const hex = (cx, cy, rx, extra = "") =>
  `<polygon points="${hexPoints(cx, cy, rx)}"${extra}/>`;
const poly = (pts, extra = "") =>
  `<polyline points="${pts.map(([x, y]) => `${n(x)},${n(y)}`).join(" ")}"${extra}/>`;
const arc = (cx, cy, r, a0, a1, extra = "") => {
  const p0 = [cx + r * Math.cos(a0), cy + r * Math.sin(a0)];
  const p1 = [cx + r * Math.cos(a1), cy + r * Math.sin(a1)];
  const large = Math.abs(a1 - a0) > Math.PI ? 1 : 0;
  return `<path d="M${n(p0[0])} ${n(p0[1])}A${n(r)} ${n(r)} 0 ${large} 1 ${n(p1[0])} ${n(p1[1])}"${extra}/>`;
};
/** a small chevron at (x, y) pointing along `angle` (radians) */
const chevron = (x, y, angle, size) => {
  const a = angle + Math.PI * 0.8;
  const b = angle - Math.PI * 0.8;
  return poly([
    [x + size * Math.cos(a), y + size * Math.sin(a)],
    [x, y],
    [x + size * Math.cos(b), y + size * Math.sin(b)],
  ]);
};
const quiet = (p) => ` stroke="${p.tone[0]}"`;
const loud = (p) => ` stroke="${p.tone[2]}"`;
const punch = (p) => ` fill="${p.surface}"`;

/** A knowledge graph: typed nodes, the edges between them, a few labels. */
function graph(p) {
  const { rand, s } = p;
  const nodes = [];
  const count = 11 + Math.floor(rand() * 4);
  let tries = 0;
  while (nodes.length < count && tries++ < 400) {
    const x = p.x + p.w * (0.08 + rand() * 0.84);
    const y = p.y + p.h * (0.08 + rand() * 0.84);
    if (nodes.every((q) => Math.hypot(q.x - x, q.y - y) > s * 0.17)) {
      nodes.push({ x, y, hex: nodes.length % 3 === 0 });
    }
  }
  const out = [];
  const seen = new Set();
  nodes.forEach((a, i) => {
    const near = nodes
      .map((b, j) => ({ j, d: Math.hypot(a.x - b.x, a.y - b.y) }))
      .filter((e) => e.j !== i)
      .sort((u, v) => u.d - v.d)
      .slice(0, 2);
    for (const e of near) {
      const key = i < e.j ? `${i}-${e.j}` : `${e.j}-${i}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const b = nodes[e.j];
      out.push(line(a.x, a.y, b.x, b.y, quiet(p)));
      // a direction on some edges: the graph is typed and edges carry a source
      if (rand() < 0.5) {
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        out.push(chevron(mx, my, Math.atan2(b.y - a.y, b.x - a.x), s * 0.014));
      }
    }
  });
  for (const v of nodes) {
    out.push(
      v.hex
        ? hex(v.x, v.y, s * 0.03, punch(p) + loud(p))
        : circle(v.x, v.y, s * 0.018, punch(p)),
    );
    if (rand() < 0.4) {
      // a label stub beside the node
      const lx = v.x + s * 0.045;
      out.push(line(lx, v.y, lx + s * (0.05 + rand() * 0.06), v.y, quiet(p)));
    }
  }
  return out.join("");
}

/** An ontology: a class lattice with is-a arrows and a time axis under it. */
function ontology(p) {
  const { rand, s } = p;
  const bw = s * 0.17;
  const bh = s * 0.075;
  const rows = [
    [p.cx],
    [p.cx - s * 0.3, p.cx, p.cx + s * 0.3],
    [p.cx - s * 0.42, p.cx - s * 0.21, p.cx, p.cx + s * 0.21, p.cx + s * 0.42],
  ];
  const ys = [p.y + p.h * 0.12, p.y + p.h * 0.42, p.y + p.h * 0.72];
  const out = [];
  rows.forEach((xs, r) => {
    const y = ys[r];
    xs.forEach((x, i) => {
      out.push(rect(x - bw / 2, y, bw, bh, r === 0 ? loud(p) : ""));
      // a name line inside each class
      out.push(
        line(
          x - bw * 0.36,
          y + bh * 0.5,
          x - bw * 0.36 + bw * (0.3 + rand() * 0.4),
          y + bh * 0.5,
          quiet(p),
        ),
      );
      if (r > 0) {
        const parent =
          rows[r - 1][
            Math.min(
              rows[r - 1].length - 1,
              Math.floor((i / xs.length) * rows[r - 1].length),
            )
          ];
        const bus = ys[r - 1] + bh + (y - ys[r - 1] - bh) / 2;
        out.push(
          poly(
            [
              [x, y],
              [x, bus],
              [parent, bus],
              [parent, ys[r - 1] + bh + s * 0.02],
            ],
            quiet(p),
          ),
        );
        // a hollow is-a triangle at the parent
        const a = s * 0.016;
        out.push(
          poly(
            [
              [parent - a, ys[r - 1] + bh + a * 1.4],
              [parent, ys[r - 1] + bh],
              [parent + a, ys[r - 1] + bh + a * 1.4],
              [parent - a, ys[r - 1] + bh + a * 1.4],
            ],
            punch(p),
          ),
        );
      }
    });
  });
  // facts have a clock: a time axis with an as-of marker
  const ty = p.y + p.h * 0.93;
  out.push(line(p.x + p.w * 0.08, ty, p.x + p.w * 0.92, ty));
  for (let i = 0; i <= 12; i++) {
    const x = p.x + p.w * (0.08 + (0.84 * i) / 12);
    out.push(line(x, ty, x, ty - s * (i % 4 === 0 ? 0.03 : 0.015), quiet(p)));
  }
  const asOf = p.x + p.w * (0.3 + rand() * 0.5);
  out.push(circle(asOf, ty, s * 0.014, punch(p) + loud(p)));
  return out.join("");
}

/** An agent's loop: plan, act, observe, verify, round a contract. */
function loop(p) {
  const { rand, s } = p;
  const R = s * 0.34;
  const out = [];
  out.push(circle(p.cx, p.cy, R, quiet(p)));
  out.push(
    circle(
      p.cx,
      p.cy,
      R * 0.62,
      ` stroke-dasharray="${n(s * 0.012)} ${n(s * 0.02)}"` + quiet(p),
    ),
  );
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const len = i % 6 === 0 ? s * 0.03 : s * 0.012;
    out.push(
      line(
        p.cx + (R + s * 0.02) * Math.cos(a),
        p.cy + (R + s * 0.02) * Math.sin(a),
        p.cx + (R + s * 0.02 + len) * Math.cos(a),
        p.cy + (R + s * 0.02 + len) * Math.sin(a),
        quiet(p),
      ),
    );
  }
  const start = -Math.PI / 2 + (rand() - 0.5) * 0.4;
  for (let i = 0; i < 4; i++) {
    const a0 = start + (i * Math.PI) / 2 + 0.22;
    const a1 = start + ((i + 1) * Math.PI) / 2 - 0.22;
    out.push(arc(p.cx, p.cy, R, a0, a1));
    out.push(
      chevron(
        p.cx + R * Math.cos(a1),
        p.cy + R * Math.sin(a1),
        a1 + Math.PI / 2,
        s * 0.018,
      ),
    );
  }
  for (let i = 0; i < 4; i++) {
    const a = start + (i * Math.PI) / 2;
    const x = p.cx + R * Math.cos(a);
    const y = p.cy + R * Math.sin(a);
    out.push(
      i === 3
        ? hex(x, y, s * 0.04, punch(p) + loud(p))
        : circle(x, y, s * 0.036, punch(p)),
    );
  }
  // the contract the loop runs inside
  out.push(hex(p.cx, p.cy, s * 0.07, loud(p)));
  out.push(hex(p.cx, p.cy, s * 0.035, quiet(p)));
  return out.join("");
}

/**
 * A tool call: a prompt, lines of a log, a cursor. The panel the drawing
 * sits in is the terminal, so the drawing is only what it printed.
 */
function terminal(p) {
  const { rand, s } = p;
  const x0 = p.x + p.w * 0.06;
  const y0 = p.y + p.h * 0.04;
  const w = p.w * 0.88;
  const h = p.h * 0.92;
  const out = [];
  const rows = Math.floor((h - s * 0.05) / (s * 0.065));
  let y = y0 + s * 0.03;
  let indent = 0;
  for (let i = 0; i < rows; i++) {
    const prompt = rand() < 0.3;
    if (prompt) indent = 0;
    const x = x0 + s * 0.05 + indent * s * 0.06;
    if (prompt) {
      out.push(chevron(x + s * 0.012, y, 0, s * 0.014));
      out.push(
        line(
          x + s * 0.04,
          y,
          x + s * 0.04 + w * (0.15 + rand() * 0.3),
          y,
          loud(p),
        ),
      );
    } else {
      out.push(line(x, y, x + w * (0.1 + rand() * 0.45), y, quiet(p)));
    }
    if (!prompt && rand() < 0.4) indent = Math.min(2, indent + 1);
    if (rand() < 0.25) indent = Math.max(0, indent - 1);
    y += s * 0.065;
  }
  // the cursor, and a brace pair as the log's shape
  out.push(
    rect(
      x0 + s * 0.05,
      y - s * 0.02,
      s * 0.018,
      s * 0.035,
      ` fill="${p.tone[2]}" stroke="none"`,
    ),
  );
  const bx = x0 + w - s * 0.12;
  const by = y0 + h * 0.35;
  out.push(
    `<path d="M${n(bx)} ${n(by)}q${n(-s * 0.03)} 0 ${n(-s * 0.03)} ${n(s * 0.04)}v${n(s * 0.06)}q0 ${n(s * 0.03)} ${n(-s * 0.03)} ${n(s * 0.03)}q${n(s * 0.03)} 0 ${n(s * 0.03)} ${n(s * 0.03)}v${n(s * 0.06)}q0 ${n(s * 0.04)} ${n(s * 0.03)} ${n(s * 0.04)}"${quiet(p)}/>`,
  );
  return out.join("");
}

/** A policy gate: a checkpoint, a shield with a keyhole, a sealed contract. */
function gate(p) {
  const { rand, s } = p;
  const out = [];
  // the flow through the gate
  const fy = p.cy;
  out.push(
    line(
      p.x + p.w * 0.06,
      fy,
      p.x + p.w * 0.94,
      fy,
      ` stroke-dasharray="${n(s * 0.01)} ${n(s * 0.025)}"` + quiet(p),
    ),
  );
  // the checkpoint: two posts and a bar, and the check
  const gx = p.x + p.w * 0.22;
  out.push(line(gx - s * 0.06, fy - s * 0.16, gx - s * 0.06, fy + s * 0.16));
  out.push(line(gx + s * 0.06, fy - s * 0.16, gx + s * 0.06, fy + s * 0.16));
  out.push(line(gx - s * 0.06, fy - s * 0.16, gx + s * 0.06, fy - s * 0.16));
  out.push(
    poly(
      [
        [gx - s * 0.03, fy],
        [gx - s * 0.008, fy + s * 0.025],
        [gx + s * 0.035, fy - s * 0.03],
      ],
      loud(p),
    ),
  );
  // the shield
  const sx = p.cx + s * 0.02;
  const top = fy - s * 0.26;
  const hw = s * 0.18;
  out.push(
    `<path d="M${n(sx - hw)} ${n(top)}H${n(sx + hw)}V${n(top + s * 0.22)}Q${n(sx + hw)} ${n(top + s * 0.42)} ${n(sx)} ${n(top + s * 0.52)}Q${n(sx - hw)} ${n(top + s * 0.42)} ${n(sx - hw)} ${n(top + s * 0.22)}Z"${punch(p)}/>`,
  );
  out.push(circle(sx, top + s * 0.2, s * 0.035, loud(p)));
  out.push(
    poly(
      [
        [sx - s * 0.016, top + s * 0.232],
        [sx - s * 0.03, top + s * 0.34],
        [sx + s * 0.03, top + s * 0.34],
        [sx + s * 0.016, top + s * 0.232],
      ],
      punch(p) + loud(p),
    ),
  );
  // the seal: a hex contract in a ring of ticks
  const kx = p.x + p.w * 0.8;
  const ky = fy + (rand() - 0.5) * s * 0.1;
  out.push(circle(kx, ky, s * 0.12, punch(p)));
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    out.push(
      line(
        kx + s * 0.13 * Math.cos(a),
        ky + s * 0.13 * Math.sin(a),
        kx + s * (i % 4 === 0 ? 0.16 : 0.145) * Math.cos(a),
        ky + s * (i % 4 === 0 ? 0.16 : 0.145) * Math.sin(a),
        quiet(p),
      ),
    );
  }
  out.push(hex(kx, ky, s * 0.055, loud(p)));
  return out.join("");
}

/** An audit ledger: linked blocks, a hash at every link, a timeline, a seal. */
function ledger(p) {
  const { rand, s } = p;
  const out = [];
  const count = 5;
  const bw = p.w * 0.13;
  const bh = s * 0.12;
  const gap = (p.w * 0.84 - count * bw) / (count - 1);
  const y = p.cy - bh * 0.9;
  for (let i = 0; i < count; i++) {
    const x = p.x + p.w * 0.08 + i * (bw + gap);
    out.push(rect(x, y, bw, bh, i === count - 1 ? loud(p) : ""));
    out.push(
      line(
        x + bw * 0.15,
        y + bh * 0.35,
        x + bw * (0.3 + rand() * 0.5),
        y + bh * 0.35,
        quiet(p),
      ),
    );
    out.push(
      line(
        x + bw * 0.15,
        y + bh * 0.65,
        x + bw * (0.3 + rand() * 0.4),
        y + bh * 0.65,
        quiet(p),
      ),
    );
    if (i < count - 1) {
      const lx = x + bw;
      const my = y + bh / 2;
      out.push(line(lx, my, lx + gap, my, quiet(p)));
      const d = s * 0.018;
      out.push(
        poly(
          [
            [lx + gap / 2, my - d],
            [lx + gap / 2 + d, my],
            [lx + gap / 2, my + d],
            [lx + gap / 2 - d, my],
            [lx + gap / 2, my - d],
          ],
          punch(p),
        ),
      );
    }
  }
  // the timeline the blocks were appended along
  const ty = y + bh + s * 0.12;
  out.push(line(p.x + p.w * 0.08, ty, p.x + p.w * 0.92, ty, quiet(p)));
  for (let i = 0; i <= 20; i++) {
    const x = p.x + p.w * (0.08 + (0.84 * i) / 20);
    out.push(line(x, ty, x, ty + s * (i % 5 === 0 ? 0.03 : 0.012), quiet(p)));
  }
  for (let i = 0; i < count; i++) {
    const x = p.x + p.w * 0.08 + i * (bw + gap) + bw / 2;
    out.push(circle(x, ty, s * 0.012, punch(p)));
  }
  // the seal at the end of the record
  const kx = p.x + p.w * 0.86;
  const ky = y - s * 0.14;
  out.push(circle(kx, ky, s * 0.08, punch(p) + loud(p)));
  out.push(circle(kx, ky, s * 0.05, quiet(p)));
  out.push(hex(kx, ky, s * 0.025));
  return out.join("");
}

/** A meter: a gauge, a run's bars, and the receipt it becomes. */
function meter(p) {
  const { rand, s } = p;
  const out = [];
  const gx = p.x + p.w * 0.36;
  const gy = p.cy + s * 0.14;
  const R = s * 0.3;
  const a0 = Math.PI * 1.1;
  const a1 = Math.PI * 1.9;
  out.push(arc(gx, gy, R, a0, a1));
  out.push(arc(gx, gy, R * 0.82, a0, a1, quiet(p)));
  for (let i = 0; i <= 20; i++) {
    const a = a0 + ((a1 - a0) * i) / 20;
    const len = i % 5 === 0 ? s * 0.05 : s * 0.025;
    out.push(
      line(
        gx + R * Math.cos(a),
        gy + R * Math.sin(a),
        gx + (R - len) * Math.cos(a),
        gy + (R - len) * Math.sin(a),
        i % 5 === 0 ? "" : quiet(p),
      ),
    );
  }
  const needle = a0 + (a1 - a0) * (0.55 + rand() * 0.35);
  out.push(
    line(
      gx,
      gy,
      gx + R * 0.72 * Math.cos(needle),
      gy + R * 0.72 * Math.sin(needle),
      loud(p),
    ),
  );
  out.push(circle(gx, gy, s * 0.022, punch(p) + loud(p)));
  // the bars of a run, and the receipt they become
  const bx = p.x + p.w * 0.66;
  const by = p.cy + s * 0.2;
  for (let i = 0; i < 6; i++) {
    const h = s * (0.06 + rand() * 0.2);
    out.push(
      rect(
        bx + i * s * 0.05,
        by - h,
        s * 0.032,
        h,
        i === 5 ? loud(p) : quiet(p),
      ),
    );
  }
  out.push(line(bx - s * 0.02, by, bx + s * 0.3, by, quiet(p)));
  const rx = p.x + p.w * 0.66;
  const ry = p.y + p.h * 0.1;
  out.push(rect(rx, ry, s * 0.3, s * 0.2));
  for (let i = 0; i < 4; i++) {
    const yy = ry + s * (0.05 + i * 0.04);
    out.push(
      line(rx + s * 0.03, yy, rx + s * (0.1 + rand() * 0.1), yy, quiet(p)),
    );
    out.push(line(rx + s * 0.22, yy, rx + s * 0.27, yy, quiet(p)));
  }
  out.push(
    line(
      rx + s * 0.03,
      ry + s * 0.17,
      rx + s * 0.27,
      ry + s * 0.17,
      ` stroke-dasharray="${n(s * 0.01)} ${n(s * 0.01)}"`,
    ),
  );
  return out.join("");
}

const DRAWINGS = { graph, ontology, loop, terminal, gate, ledger, meter };
