// The drawings a generated image is made of.
//
// Two layers. The honeycomb is the brand's own cell (the cluster in
// oxagen-house-brand/build/marks.py, the .tex-hex texture in oxagen.css)
// scattered as a field of rings and flat blocks with exactly one cell in
// gold. Over or beside it sits one of seven hairline drawings of the things
// the writing is about: a knowledge graph, an ontology, an agent's loop, a
// tool call, a policy gate, an audit ledger, a meter. Hairlines in the
// theme's quiet tones, so a drawing reads as a watermark rather than a
// figure; never a gradient, never a translucent fill.
//
// Everything takes a seeded `rand`, so an image is a pure function of its
// seed and theme and rebuilds identically.

import { blockTones, lineTones } from "./theme.mjs";

export const TREATMENTS = [
  "graph",
  "ontology",
  "loop",
  "terminal",
  "gate",
  "ledger",
  "meter",
];

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

const pick = (rand, list) => list[Math.floor(rand() * list.length)];
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

/**
 * A field of honeycomb cells filling a box, denser at the box's centre and
 * thinning to its edges, with exactly one solid gold cell kept well inside.
 * @param {{ rand: () => number, t: object, x: number, y: number, w: number, h: number,
 *   cell: number, density: number, tilt?: number, gold?: boolean }} o
 *   cell is a cell's half-width in px; density the chance a central cell draws
 */
export function honeycomb(o) {
  const { rand, t } = o;
  const rx = o.cell;
  const ry = rx * CELL_ASPECT;
  const pitchX = rx * 2.06;
  const pitchY = ry * 1.545;
  const cx0 = o.x + o.w / 2;
  const cy0 = o.y + o.h / 2;
  const pad = ry * 2;
  const cols = Math.ceil((o.w + pad * 2) / pitchX) + 1;
  const rows = Math.ceil((o.h + pad * 2) / pitchY) + 1;
  const cells = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const cx = o.x - pad + col * pitchX + (row % 2 ? pitchX / 2 : 0);
      const cy = o.y - pad + row * pitchY;
      const dist = Math.hypot((cx - cx0) / (o.w / 2), (cy - cy0) / (o.h / 2));
      cells.push({ cx, cy, dist });
    }
  }
  const inner = cells.filter((c) => c.dist < 0.6);
  const goldCell = o.gold === false ? null : pick(rand, inner);
  const blocks = blockTones(t);
  const lines = lineTones(t);
  const out = [];
  for (const c of cells) {
    const isGold = c === goldCell;
    const chance = o.density * (1 - Math.min(c.dist, 1) ** 1.6);
    if (!isGold && rand() >= chance) continue;
    const pts = hexPoints(c.cx, c.cy, rx, ry);
    if (isGold) out.push(`<polygon points="${pts}" fill="${t.gold}"/>`);
    else if (rand() < 0.6)
      out.push(`<polygon points="${pts}" fill="${pick(rand, blocks)}"/>`);
    else
      out.push(
        `<polygon points="${pts}" fill="none" stroke="${pick(rand, lines)}" stroke-width="1.6"/>`,
      );
  }
  const tilt = o.tilt ?? 0;
  return `<g transform="rotate(${tilt.toFixed(2)} ${n(cx0)} ${n(cy0)})">${out.join("")}</g>`;
}

// --------------------------------------------------------------------------
// hairline drawings
// --------------------------------------------------------------------------

/**
 * @param {string} name one of TREATMENTS
 * @param {{ rand: () => number, t: object, x: number, y: number, w: number, h: number }} box
 */
export function drawing(name, box) {
  const fn = DRAWINGS[name];
  if (!fn) throw new Error(`unknown treatment "${name}"`);
  const s = Math.min(box.w, box.h);
  const p = {
    ...box,
    s,
    cx: box.x + box.w / 2,
    cy: box.y + box.h / 2,
    sw: Math.max(1.2, s * 0.0035),
    tone: lineTones(box.t),
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
const punch = (p) => ` fill="${p.t.ground}"`;

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

/** A tool call: a terminal panel, a prompt, lines of a log, a cursor. */
function terminal(p) {
  const { rand, s } = p;
  const x0 = p.x + p.w * 0.08;
  const y0 = p.y + p.h * 0.1;
  const w = p.w * 0.84;
  const h = p.h * 0.8;
  const out = [rect(x0, y0, w, h)];
  const bar = y0 + s * 0.07;
  out.push(line(x0, bar, x0 + w, bar, quiet(p)));
  for (let i = 0; i < 3; i++)
    out.push(
      circle(x0 + s * (0.04 + i * 0.035), y0 + s * 0.035, s * 0.009, quiet(p)),
    );
  const rows = Math.floor((h - s * 0.12) / (s * 0.065));
  let y = bar + s * 0.07;
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
