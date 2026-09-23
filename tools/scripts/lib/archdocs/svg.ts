/**
 * Deterministic inline-SVG renderers for the architecture atlas.
 *
 * Every function here is pure: same input, same bytes out. Strokes and text
 * use `currentColor` so a figure inherits the page's foreground in both
 * themes; the one literal hue (`ACCENT`) is reserved for the element a figure
 * is about. No `<script>`, `<style>`, or `<foreignObject>` ever appears inside
 * a figure — the page's stylesheet styles the classes emitted here.
 */

export const ACCENT = "var(--accent, #D6962C)";

const CHAR_W = 6.9; // average glyph advance at 12px for the atlas face
const MONO_CHAR_W = 7.2;

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function textWidth(s: string, size = 12, mono = false): number {
  return s.length * (mono ? MONO_CHAR_W : CHAR_W) * (size / 12);
}

/** Greedy word wrap to a maximum width in px. */
export function wrap(s: string, maxWidth: number, size = 12): string[] {
  const words = s.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (textWidth(next, size) > maxWidth && cur) {
      lines.push(cur);
      cur = w;
    } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

export function defs(id = "arrow"): string {
  return (
    `<defs>` +
    `<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">` +
    `<path d="M0,0 L10,5 L0,10 z" fill="currentColor"/></marker>` +
    `<marker id="${id}-accent" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">` +
    `<path d="M0,0 L10,5 L0,10 z" fill="${ACCENT}"/></marker>` +
    `<marker id="${id}-dot" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6">` +
    `<circle cx="5" cy="5" r="4" fill="currentColor"/></marker>` +
    `</defs>`
  );
}

export function svgOpen(w: number, h: number, label: string, cls = ""): string {
  // A wide figure keeps its drawn scale and scrolls inside its frame instead of
  // shrinking its 12px labels below legibility.
  const minW =
    w > 900 ? ` style="min-width:${Math.min(Math.round(w), 1500)}px"` : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fmt(w)} ${fmt(h)}" role="img" aria-label="${esc(label)}" class="fig ${cls}"${minW}>` +
    `<title>${esc(label)}</title>` +
    defs()
  );
}

export function text(
  x: number,
  y: number,
  s: string,
  opts: {
    size?: number;
    anchor?: "start" | "middle" | "end";
    cls?: string;
    mono?: boolean;
    weight?: number;
    halo?: boolean;
    fill?: string;
  } = {},
): string {
  const size = opts.size ?? 12;
  const attrs = [
    `x="${fmt(x)}"`,
    `y="${fmt(y)}"`,
    `font-size="${size}"`,
    opts.anchor ? `text-anchor="${opts.anchor}"` : "",
    opts.mono
      ? `font-family="ui-monospace, SFMono-Regular, Menlo, monospace"`
      : "",
    opts.weight ? `font-weight="${opts.weight}"` : "",
    `fill="${opts.fill ?? "currentColor"}"`,
    opts.cls ? `class="${opts.cls}"` : "",
    opts.halo
      ? `paint-order="stroke" stroke="var(--fig-ground, #fff)" stroke-width="4" stroke-linejoin="round"`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `<text ${attrs}>${esc(s)}</text>`;
}

export function rect(
  x: number,
  y: number,
  w: number,
  h: number,
  opts: {
    r?: number;
    cls?: string;
    fill?: string;
    stroke?: string;
    dash?: boolean;
    sw?: number;
  } = {},
): string {
  return `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" rx="${opts.r ?? 4}" fill="${opts.fill ?? "var(--fig-panel, transparent)"}" stroke="${opts.stroke ?? "currentColor"}" stroke-width="${opts.sw ?? 1}"${opts.dash ? ' stroke-dasharray="4 3"' : ""}${opts.cls ? ` class="${opts.cls}"` : ""}/>`;
}

export interface EdgeStyle {
  dashed?: boolean;
  accent?: boolean;
  thin?: boolean;
  noArrow?: boolean;
}

export function pathEl(d: string, style: EdgeStyle = {}, extra = ""): string {
  const stroke = style.accent ? ACCENT : "currentColor";
  const marker = style.noArrow
    ? ""
    : ` marker-end="url(#${style.accent ? "arrow-accent" : "arrow"})"`;
  return `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${style.thin ? 1 : 1.4}"${style.dashed ? ' stroke-dasharray="5 4"' : ""}${marker}${extra}/>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Layered DAG (dependency graphs, event graphs, CI job graphs, state machines)
// ─────────────────────────────────────────────────────────────────────────────

export interface DagNode {
  id: string;
  label: string;
  sub?: string;
  /** Visual class hook, e.g. "app" | "pkg" | "event" | "fn" | "state". */
  kind?: string;
  accent?: boolean;
}

export interface DagEdge {
  from: string;
  to: string;
  label?: string;
  style?: EdgeStyle;
}

export interface DagOptions {
  /** "down": sources at top (edges point down). "right": sources at left. */
  direction?: "down" | "right";
  nodeGapX?: number;
  nodeGapY?: number;
  minNodeW?: number;
  nodeH?: number;
  /** Drop edges implied by a longer path (dependency graphs). */
  transitiveReduction?: boolean;
  /** Extra class on the root svg. */
  cls?: string;
  label: string;
}

export interface Placed extends DagNode {
  x: number;
  y: number;
  w: number;
  h: number;
  layer: number;
}

/** Longest-path layering from the sources. Cycles are broken by DFS back-edge removal. */
export function layer(
  nodes: DagNode[],
  edges: DagEdge[],
): { layers: Map<string, number>; backEdges: Set<DagEdge> } {
  const ids = nodes.map((n) => n.id);
  const out = new Map<string, DagEdge[]>();
  for (const id of ids) out.set(id, []);
  for (const e of edges)
    if (out.has(e.from) && out.has(e.to)) out.get(e.from)!.push(e);
  // DFS to find back edges (deterministic: nodes in given order, edges in given order)
  const state = new Map<string, 0 | 1 | 2>();
  const backEdges = new Set<DagEdge>();
  const visit = (id: string): void => {
    state.set(id, 1);
    for (const e of out.get(id)!) {
      const s = state.get(e.to) ?? 0;
      if (s === 1) backEdges.add(e);
      else if (s === 0) visit(e.to);
    }
    state.set(id, 2);
  };
  for (const id of ids) if (!state.get(id)) visit(id);
  const fwd = edges.filter(
    (e) => !backEdges.has(e) && out.has(e.from) && out.has(e.to),
  );
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const e of fwd) indeg.set(e.to, indeg.get(e.to)! + 1);
  const layers = new Map<string, number>(ids.map((id) => [id, 0]));
  const queue = ids.filter((id) => indeg.get(id) === 0);
  const seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of fwd.filter((e) => e.from === id)) {
      layers.set(e.to, Math.max(layers.get(e.to)!, layers.get(id)! + 1));
      indeg.set(e.to, indeg.get(e.to)! - 1);
      if (indeg.get(e.to) === 0) queue.push(e.to);
    }
  }
  return { layers, backEdges };
}

/** Remove edges (a→c) when a longer path a→…→c exists. */
export function transitiveReduce(
  nodes: DagNode[],
  edges: DagEdge[],
): DagEdge[] {
  const out = new Map<string, Set<string>>();
  for (const n of nodes) out.set(n.id, new Set());
  for (const e of edges) out.get(e.from)?.add(e.to);
  const reach = new Map<string, Set<string>>();
  const memo = (id: string, stack = new Set<string>()): Set<string> => {
    if (reach.has(id)) return reach.get(id)!;
    if (stack.has(id)) return new Set();
    stack.add(id);
    const r = new Set<string>();
    for (const t of out.get(id) ?? []) {
      r.add(t);
      for (const tt of memo(t, stack)) r.add(tt);
    }
    stack.delete(id);
    reach.set(id, r);
    return r;
  };
  return edges.filter((e) => {
    for (const mid of out.get(e.from) ?? []) {
      if (mid !== e.to && memo(mid).has(e.to)) return false;
    }
    return true;
  });
}

function nodeSize(
  n: DagNode,
  minW: number,
  h: number,
): { w: number; h: number } {
  const w = Math.max(
    minW,
    textWidth(n.label, 12, true) + 24,
    n.sub ? textWidth(n.sub, 10) + 24 : 0,
  );
  return { w: Math.ceil(w), h: n.sub ? h + 12 : h };
}

/** Sugiyama-lite placement. Returns placed nodes and the reduced edge set. */
export function layoutDag(
  nodes: DagNode[],
  edgesIn: DagEdge[],
  opts: DagOptions,
): {
  placed: Placed[];
  edges: DagEdge[];
  backEdges: Set<DagEdge>;
  w: number;
  h: number;
} {
  const edges = opts.transitiveReduction
    ? transitiveReduce(nodes, edgesIn)
    : edgesIn.filter(
        (e) =>
          nodes.some((n) => n.id === e.from) &&
          nodes.some((n) => n.id === e.to),
      );
  const { layers, backEdges } = layer(nodes, edges);
  const maxLayer = Math.max(0, ...layers.values());
  const byLayer: DagNode[][] = Array.from({ length: maxLayer + 1 }, () => []);
  for (const n of nodes) byLayer[layers.get(n.id)!]!.push(n);
  // barycenter ordering, 4 sweeps, ties broken by id
  const pos = new Map<string, number>();
  byLayer.forEach((l) => l.forEach((n, i) => pos.set(n.id, i)));
  const neighbors = (id: string, dir: "up" | "down"): string[] =>
    edges
      .filter((e) => (dir === "up" ? e.to === id : e.from === id))
      .map((e) => (dir === "up" ? e.from : e.to));
  for (let sweep = 0; sweep < 4; sweep++) {
    const order =
      sweep % 2 === 0 ? byLayer.keys() : [...byLayer.keys()].reverse();
    for (const li of order) {
      const dir = sweep % 2 === 0 ? "up" : "down";
      const l = byLayer[li]!;
      const bary = new Map<string, number>();
      for (const n of l) {
        const ns = neighbors(n.id, dir).map((m) => pos.get(m) ?? 0);
        bary.set(
          n.id,
          ns.length
            ? ns.reduce((a, b) => a + b, 0) / ns.length
            : pos.get(n.id)!,
        );
      }
      l.sort(
        (a, b) => bary.get(a.id)! - bary.get(b.id)! || a.id.localeCompare(b.id),
      );
      l.forEach((n, i) => pos.set(n.id, i));
    }
  }
  const gapX = opts.nodeGapX ?? 18;
  const gapY = opts.nodeGapY ?? 56;
  const minW = opts.minNodeW ?? 96;
  const nodeH = opts.nodeH ?? 34;
  const down = (opts.direction ?? "down") === "down";
  const sized = byLayer.map((l) =>
    l.map((n) => ({ n, ...nodeSize(n, minW, nodeH) })),
  );
  const placed: Placed[] = [];
  if (down) {
    const widths = sized.map(
      (l) => l.reduce((a, s) => a + s.w, 0) + gapX * Math.max(0, l.length - 1),
    );
    const W = Math.max(...widths, 200) + 24;
    let y = 12;
    sized.forEach((l, li) => {
      const lw = widths[li]!;
      let x = (W - lw) / 2;
      const lh = Math.max(...l.map((s) => s.h), nodeH);
      for (const s of l) {
        placed.push({ ...s.n, x, y, w: s.w, h: s.h, layer: li });
        x += s.w + gapX;
      }
      y += lh + gapY;
    });
    return { placed, edges, backEdges, w: W, h: y - gapY + 12 };
  }
  // right
  const colW = sized.map((l) => Math.max(...l.map((s) => s.w), minW));
  const heights = sized.map(
    (l) => l.reduce((a, s) => a + s.h, 0) + 14 * Math.max(0, l.length - 1),
  );
  const H = Math.max(...heights, 120) + 24;
  let x = 12;
  sized.forEach((l, li) => {
    let y = (H - heights[li]!) / 2;
    for (const s of l) {
      placed.push({ ...s.n, x, y, w: colW[li]!, h: s.h, layer: li });
      y += s.h + 14;
    }
    x += colW[li]! + gapY;
  });
  return { placed, edges, backEdges, w: x - gapY + 12, h: H };
}

export function renderDag(
  nodes: DagNode[],
  edgesIn: DagEdge[],
  opts: DagOptions,
): string {
  const { placed, edges, backEdges, w, h } = layoutDag(nodes, edgesIn, opts);
  const byId = new Map(placed.map((p) => [p.id, p]));
  const down = (opts.direction ?? "down") === "down";
  let out = svgOpen(w, h, opts.label, `dag ${opts.cls ?? ""}`);
  for (const e of edges) {
    const a = byId.get(e.from)!;
    const b = byId.get(e.to)!;
    const back = backEdges.has(e);
    let d: string;
    let mx: number;
    let my: number;
    if (down) {
      const x1 = a.x + a.w / 2;
      const y1 = back ? a.y : a.y + a.h;
      const x2 = b.x + b.w / 2;
      const y2 = back ? b.y + b.h : b.y;
      if (back) {
        const bend = Math.max(a.w, b.w) / 2 + 30;
        const cx = Math.max(x1, x2) + bend;
        d = `M${fmt(x1)},${fmt(y1)} C${fmt(cx)},${fmt(y1 - 40)} ${fmt(cx)},${fmt(y2 + 40)} ${fmt(x2)},${fmt(y2)}`;
        mx = cx - 8;
        my = (y1 + y2) / 2;
      } else {
        const cy = (y1 + y2) / 2;
        d = `M${fmt(x1)},${fmt(y1)} C${fmt(x1)},${fmt(cy)} ${fmt(x2)},${fmt(cy)} ${fmt(x2)},${fmt(y2)}`;
        mx = (x1 + x2) / 2;
        my = cy;
      }
    } else {
      const x1 = back ? a.x : a.x + a.w;
      const y1 = a.y + a.h / 2;
      const x2 = back ? b.x + b.w : b.x;
      const y2 = b.y + b.h / 2;
      if (back) {
        const cy = Math.min(a.y, b.y) - 30;
        d = `M${fmt(x1)},${fmt(y1)} C${fmt(x1 - 40)},${fmt(cy)} ${fmt(x2 + 40)},${fmt(cy)} ${fmt(x2)},${fmt(y2)}`;
        mx = (x1 + x2) / 2;
        my = cy + 8;
      } else {
        const cx = (x1 + x2) / 2;
        d = `M${fmt(x1)},${fmt(y1)} C${fmt(cx)},${fmt(y1)} ${fmt(cx)},${fmt(y2)} ${fmt(x2)},${fmt(y2)}`;
        mx = cx;
        my = (y1 + y2) / 2;
      }
    }
    out += `<g class="edge" data-from="${esc(e.from)}" data-to="${esc(e.to)}">${pathEl(d, e.style)}`;
    if (e.label)
      out += text(mx, my - 3, e.label, {
        size: 10,
        anchor: "middle",
        halo: true,
        cls: "elabel",
      });
    out += `</g>`;
  }
  for (const p of placed) {
    out += `<g class="node ${p.kind ?? ""}${p.accent ? " accent" : ""}" data-id="${esc(p.id)}">`;
    out += rect(p.x, p.y, p.w, p.h, {
      r: p.kind === "state" ? 17 : p.kind === "event" ? 2 : 6,
      stroke: p.accent ? ACCENT : "currentColor",
      sw: p.accent ? 1.8 : 1,
    });
    const cy = p.sub ? p.y + 16 : p.y + p.h / 2 + 4;
    out += text(p.x + p.w / 2, cy, p.label, {
      anchor: "middle",
      mono: true,
      size: 12,
    });
    if (p.sub)
      out += text(p.x + p.w / 2, p.y + p.h - 8, p.sub, {
        anchor: "middle",
        size: 10,
        cls: "sub",
      });
    out += `</g>`;
  }
  return out + `</svg>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// ERD (table cards + reference edges)
// ─────────────────────────────────────────────────────────────────────────────

export interface ErdColumn {
  name: string;
  type: string;
  pk?: boolean;
  fk?: string; // target table id
  nullable?: boolean;
}
export interface ErdTable {
  id: string;
  name: string;
  columns: ErdColumn[];
  badge?: string; // e.g. RLS class
  tenantScoped?: boolean;
}
export interface ErdEdge {
  from: string; // table id
  fromColumn: string;
  to: string; // table id
  inferred?: boolean; // dashed
}

const ERD_ROW = 15;
const ERD_HEAD = 24;
const ERD_W = 236;

export function renderErd(
  tables: ErdTable[],
  edges: ErdEdge[],
  label: string,
  opts: { columns?: number; externalLabel?: (id: string) => string } = {},
): string {
  const cols =
    opts.columns ??
    Math.min(4, Math.max(1, Math.ceil(Math.sqrt(tables.length * 0.9))));
  const gap = 28;
  const colH: number[] = Array.from({ length: cols }, () => 12);
  const place = new Map<string, { x: number; y: number; h: number }>();
  const sorted = [...tables].sort((a, b) => a.name.localeCompare(b.name));
  // roots (referenced most) first so parents sit high
  const refCount = new Map<string, number>();
  for (const e of edges) refCount.set(e.to, (refCount.get(e.to) ?? 0) + 1);
  sorted.sort(
    (a, b) =>
      (refCount.get(b.id) ?? 0) - (refCount.get(a.id) ?? 0) ||
      a.name.localeCompare(b.name),
  );
  // footer lines: external references (drawn as text, not stubs) and the badge
  const footer = new Map<string, string[]>();
  for (const t of tables) {
    const lines: string[] = [];
    for (const e of edges)
      if (e.from === t.id && !tables.some((x) => x.id === e.to))
        lines.push(
          `${e.fromColumn} ↗ ${opts.externalLabel ? opts.externalLabel(e.to) : e.to}`,
        );
    if (t.badge) lines.push(t.badge);
    footer.set(t.id, lines);
  }
  for (const t of sorted) {
    const h =
      ERD_HEAD +
      t.columns.length * ERD_ROW +
      8 +
      footer.get(t.id)!.length * ERD_ROW +
      (footer.get(t.id)!.length ? 6 : 0);
    let ci = 0;
    for (let i = 1; i < cols; i++) if (colH[i]! < colH[ci]!) ci = i;
    const x = 12 + ci * (ERD_W + gap);
    place.set(t.id, { x, y: colH[ci]!, h });
    colH[ci] = colH[ci]! + h + gap;
  }
  const W = 12 + cols * (ERD_W + gap) - gap + 12;
  const H = Math.max(...colH) - gap + 12;
  let out = svgOpen(W, H, label, "erd");
  const rowY = (tid: string, col: string): number => {
    const t = tables.find((x) => x.id === tid)!;
    const p = place.get(tid)!;
    const i = t.columns.findIndex((c) => c.name === col);
    return p.y + ERD_HEAD + (i < 0 ? 0 : i * ERD_ROW + ERD_ROW / 2 + 2);
  };
  const seenEdge = new Set<string>();
  for (const e of edges) {
    const key = `${e.from}.${e.fromColumn}->${e.to}`;
    if (seenEdge.has(key)) continue;
    seenEdge.add(key);
    const a = place.get(e.from);
    const b = place.get(e.to);
    if (!a) continue;
    const y1 = rowY(e.from, e.fromColumn);
    if (!b) continue; // external reference: listed in the card footer instead
    const y2 = b.y + ERD_HEAD / 2;
    const sameCol = Math.abs(a.x - b.x) < 1;
    let d: string;
    if (sameCol) {
      const x = a.x + ERD_W;
      const cx = x + 26;
      d = `M${fmt(x)},${fmt(y1)} C${fmt(cx)},${fmt(y1)} ${fmt(cx)},${fmt(y2)} ${fmt(x)},${fmt(y2)}`;
    } else if (a.x < b.x) {
      const x1 = a.x + ERD_W;
      const x2 = b.x;
      const cx = (x1 + x2) / 2;
      d = `M${fmt(x1)},${fmt(y1)} C${fmt(cx)},${fmt(y1)} ${fmt(cx)},${fmt(y2)} ${fmt(x2)},${fmt(y2)}`;
    } else {
      const x1 = a.x;
      const x2 = b.x + ERD_W;
      const cx = (x1 + x2) / 2;
      d = `M${fmt(x1)},${fmt(y1)} C${fmt(cx)},${fmt(y1)} ${fmt(cx)},${fmt(y2)} ${fmt(x2)},${fmt(y2)}`;
    }
    out += `<g class="edge" data-from="${esc(e.from)}" data-to="${esc(e.to)}">${pathEl(d, { dashed: !!e.inferred, thin: true })}</g>`;
  }
  for (const t of sorted) {
    const p = place.get(t.id)!;
    out += `<g class="table" data-id="${esc(t.id)}">`;
    out += rect(p.x, p.y, ERD_W, p.h, { r: 5 });
    out += `<rect x="${fmt(p.x)}" y="${fmt(p.y)}" width="${ERD_W}" height="${ERD_HEAD}" rx="5" fill="var(--fig-head, rgba(128,128,128,.12))" stroke="none"/>`;
    out += `<rect x="${fmt(p.x)}" y="${fmt(p.y + ERD_HEAD - 4)}" width="${ERD_W}" height="4" fill="var(--fig-head, rgba(128,128,128,.12))" stroke="none"/>`;
    out += `<line x1="${fmt(p.x)}" y1="${fmt(p.y + ERD_HEAD)}" x2="${fmt(p.x + ERD_W)}" y2="${fmt(p.y + ERD_HEAD)}" stroke="currentColor" stroke-width="1"/>`;
    out += text(p.x + 8, p.y + 16, t.name, {
      mono: true,
      weight: 600,
      size: 12,
    });
    t.columns.forEach((c, i) => {
      const y = p.y + ERD_HEAD + i * ERD_ROW + 12;
      const mark = c.pk ? "◆ " : c.fk ? "→ " : "";
      out += text(p.x + 8, y, `${mark}${c.name}`, {
        mono: true,
        size: 10,
        cls: c.pk ? "pk" : c.fk ? "fk" : "",
      });
      const ty = c.type
        .replace("timestamp with time zone", "timestamptz")
        .replace("character varying", "varchar");
      out += text(p.x + ERD_W - 8, y, ty + (c.nullable ? "?" : ""), {
        mono: true,
        size: 9,
        anchor: "end",
        cls: "ctype",
      });
    });
    const lines = footer.get(t.id)!;
    if (lines.length) {
      const fy = p.y + ERD_HEAD + t.columns.length * ERD_ROW + 6;
      out += `<line x1="${fmt(p.x + 6)}" y1="${fmt(fy)}" x2="${fmt(p.x + ERD_W - 6)}" y2="${fmt(fy)}" stroke="currentColor" stroke-opacity=".3"/>`;
      lines.forEach(
        (ln, i) =>
          (out += text(p.x + 8, fy + 12 + i * ERD_ROW, ln, {
            mono: true,
            size: 9,
            cls: i === lines.length - 1 && t.badge ? "badge" : "ext",
          })),
      );
    }
    out += `</g>`;
  }
  return out + `</svg>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sequence diagram (process flows)
// ─────────────────────────────────────────────────────────────────────────────

export interface SeqLane {
  id: string;
  label: string;
  sub?: string;
  kind?: "actor" | "service" | "store" | "external";
}
export interface SeqStep {
  from: string;
  to: string;
  label: string;
  /** Secondary line under the label, e.g. the function or table name. */
  detail?: string;
  style?: EdgeStyle;
  /** A note spanning the whole width instead of an arrow. */
  note?: boolean;
}

export function renderSequence(
  lanes: SeqLane[],
  steps: SeqStep[],
  label: string,
): string {
  const laneW = Math.max(
    150,
    ...lanes.map(
      (l) =>
        Math.max(
          textWidth(l.label, 12, true),
          l.sub ? textWidth(l.sub, 10) : 0,
        ) + 28,
    ),
  );
  const headH = 46;
  const stepH = 44;
  const W = 24 + lanes.length * laneW;
  const H = headH + 20 + steps.length * stepH + 16;
  const cx = (id: string): number =>
    24 + lanes.findIndex((l) => l.id === id) * laneW + laneW / 2;
  let out = svgOpen(W, H, label, "seq");
  lanes.forEach((l, i) => {
    const x = 24 + i * laneW + 10;
    const w = laneW - 20;
    out += `<g class="lane ${l.kind ?? "service"}">`;
    out += rect(x, 8, w, headH - 12, {
      r: l.kind === "store" ? 12 : 5,
      dash: l.kind === "external",
    });
    out += text(x + w / 2, l.sub ? 24 : 30, l.label, {
      anchor: "middle",
      mono: true,
      weight: 600,
    });
    if (l.sub)
      out += text(x + w / 2, 37, l.sub, {
        anchor: "middle",
        size: 9,
        cls: "sub",
      });
    out += `<line x1="${fmt(x + w / 2)}" y1="${headH}" x2="${fmt(x + w / 2)}" y2="${fmt(H - 8)}" stroke="currentColor" stroke-opacity=".35" stroke-dasharray="2 4"/>`;
    out += `</g>`;
  });
  steps.forEach((s, i) => {
    const y = headH + 30 + i * stepH;
    if (s.note) {
      const lines = wrap(s.label, W - 80, 11);
      out += `<g class="note"><rect x="30" y="${fmt(y - 14)}" width="${fmt(W - 60)}" height="${fmt(8 + lines.length * 13)}" rx="3" fill="var(--fig-note, rgba(214,150,44,.08))" stroke="${ACCENT}" stroke-width="1"/>`;
      lines.forEach(
        (ln, li) =>
          (out += text(W / 2, y + li * 13 - 2, ln, {
            size: 11,
            anchor: "middle",
          })),
      );
      out += `</g>`;
      return;
    }
    const x1 = cx(s.from);
    const x2 = cx(s.to);
    out += `<g class="step">`;
    out += text(12, y + 4, String(i + 1), { size: 9, cls: "num" });
    if (x1 === x2) {
      const d = `M${fmt(x1)},${fmt(y - 8)} C${fmt(x1 + 50)},${fmt(y - 8)} ${fmt(x1 + 50)},${fmt(y + 12)} ${fmt(x1 + 2)},${fmt(y + 12)}`;
      out += pathEl(d, s.style);
      out += text(x1 + 58, y + 2, s.label, { size: 11, halo: true });
      if (s.detail)
        out += text(x1 + 58, y + 14, s.detail, {
          size: 9,
          mono: true,
          cls: "detail",
          halo: true,
        });
    } else {
      const dir = x2 > x1 ? 1 : -1;
      out += pathEl(
        `M${fmt(x1)},${fmt(y)} L${fmt(x2 - dir * 2)},${fmt(y)}`,
        s.style,
      );
      const mid = (x1 + x2) / 2;
      out += text(mid, y - 5, s.label, {
        size: 11,
        anchor: "middle",
        halo: true,
      });
      if (s.detail)
        out += text(mid, y + 13, s.detail, {
          size: 9,
          anchor: "middle",
          mono: true,
          cls: "detail",
          halo: true,
        });
    }
    out += `</g>`;
  });
  return out + `</svg>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Grid topology (deployment diagrams, middleware chains)
// ─────────────────────────────────────────────────────────────────────────────

export interface GridNode {
  id: string;
  label: string;
  sub?: string;
  col: number;
  row: number;
  colspan?: number;
  rowspan?: number;
  kind?: string;
  accent?: boolean;
}
export interface GridGroup {
  label: string;
  col: number;
  row: number;
  colspan: number;
  rowspan: number;
  dashed?: boolean;
}
export interface GridEdge {
  from: string;
  to: string;
  label?: string;
  style?: EdgeStyle;
  /** Force which side of the source/target the edge leaves/enters. */
  route?: "h" | "v";
}

export function renderGrid(
  nodes: GridNode[],
  edges: GridEdge[],
  groups: GridGroup[],
  label: string,
  opts: {
    cellW?: number;
    cellH?: number;
    gapX?: number;
    gapY?: number;
    pad?: number;
  } = {},
): string {
  const cellW = opts.cellW ?? 150;
  const cellH = opts.cellH ?? 48;
  const gapX = opts.gapX ?? 84;
  const gapY = opts.gapY ?? 40;
  const pad = opts.pad ?? 16;
  const cols = Math.max(
    ...nodes.map((n) => n.col + (n.colspan ?? 1)),
    ...groups.map((g) => g.col + g.colspan),
  );
  const rows = Math.max(
    ...nodes.map((n) => n.row + (n.rowspan ?? 1)),
    ...groups.map((g) => g.row + g.rowspan),
  );
  const W = pad * 2 + cols * cellW + (cols - 1) * gapX;
  const H = pad * 2 + rows * cellH + (rows - 1) * gapY;
  const box = (col: number, row: number, cs = 1, rs = 1) => ({
    x: pad + col * (cellW + gapX),
    y: pad + row * (cellH + gapY),
    w: cs * cellW + (cs - 1) * gapX,
    h: rs * cellH + (rs - 1) * gapY,
  });
  let out = svgOpen(W, H, label, "grid");
  for (const g of groups) {
    const b = box(g.col, g.row, g.colspan, g.rowspan);
    out += `<g class="group">`;
    out += rect(b.x - 10, b.y - 22, b.w + 20, b.h + 32, {
      r: 8,
      dash: g.dashed !== false,
      fill: "var(--fig-group, rgba(128,128,128,.05))",
      sw: 1,
    });
    out += text(b.x, b.y - 9, g.label.toUpperCase(), {
      size: 9,
      cls: "group-label",
      weight: 600,
    });
    out += `</g>`;
  }
  const byId = new Map(
    nodes.map((n) => [n.id, { n, ...box(n.col, n.row, n.colspan, n.rowspan) }]),
  );
  for (const e of edges) {
    const a = byId.get(e.from)!;
    const b = byId.get(e.to)!;
    const acx = a.x + a.w / 2;
    const acy = a.y + a.h / 2;
    const bcx = b.x + b.w / 2;
    const bcy = b.y + b.h / 2;
    const horizontal =
      e.route === "h" ||
      (e.route !== "v" && Math.abs(bcy - acy) < Math.abs(bcx - acx));
    let d: string;
    let lx: number;
    let ly: number;
    if (horizontal) {
      const dir = bcx > acx ? 1 : -1;
      const x1 = dir > 0 ? a.x + a.w : a.x;
      const x2 = dir > 0 ? b.x : b.x + b.w;
      if (Math.abs(acy - bcy) < 1) {
        d = `M${fmt(x1)},${fmt(acy)} L${fmt(x2)},${fmt(bcy)}`;
        lx = (x1 + x2) / 2;
        ly = acy - 5;
      } else {
        // bend in the column gap; the label sits beside the vertical run so it
        // never lands on a neighbouring node
        const mx = (x1 + x2) / 2;
        d = `M${fmt(x1)},${fmt(acy)} L${fmt(mx)},${fmt(acy)} L${fmt(mx)},${fmt(bcy)} L${fmt(x2)},${fmt(bcy)}`;
        lx = mx;
        ly = (acy + bcy) / 2 + 3;
      }
    } else {
      const dir = bcy > acy ? 1 : -1;
      const y1 = dir > 0 ? a.y + a.h : a.y;
      const y2 = dir > 0 ? b.y : b.y + b.h;
      if (Math.abs(acx - bcx) < 1) {
        d = `M${fmt(acx)},${fmt(y1)} L${fmt(bcx)},${fmt(y2)}`;
      } else {
        const my = (y1 + y2) / 2;
        d = `M${fmt(acx)},${fmt(y1)} L${fmt(acx)},${fmt(my)} L${fmt(bcx)},${fmt(my)} L${fmt(bcx)},${fmt(y2)}`;
      }
      lx = Math.max(acx, bcx) + 6;
      ly = (y1 + y2) / 2 + 3;
    }
    out += `<g class="edge">${pathEl(d, e.style)}`;
    if (e.label) {
      // wrap to the column gap so a label never runs across a neighbouring node
      const lines = horizontal ? wrap(e.label, gapX + 30, 10) : [e.label];
      lines.forEach(
        (ln, i) =>
          (out += text(lx, ly - (lines.length - 1 - i) * 11, ln, {
            size: 10,
            anchor: horizontal ? "middle" : "start",
            halo: true,
            cls: "elabel",
          })),
      );
    }
    out += `</g>`;
  }
  for (const { n, x, y, w, h } of byId.values()) {
    out += `<g class="node ${n.kind ?? ""}${n.accent ? " accent" : ""}" data-id="${esc(n.id)}">`;
    const r = n.kind === "store" ? 14 : n.kind === "actor" ? 20 : 6;
    out += rect(x, y, w, h, {
      r,
      stroke: n.accent ? ACCENT : "currentColor",
      sw: n.accent ? 1.8 : 1,
      dash: n.kind === "external",
    });
    const lines = wrap(n.label, w - 16, 12);
    const total = lines.length * 14 + (n.sub ? 12 : 0);
    let ty = y + h / 2 - total / 2 + 11;
    for (const ln of lines) {
      out += text(x + w / 2, ty, ln, {
        anchor: "middle",
        mono: true,
        weight: 600,
        size: 12,
      });
      ty += 14;
    }
    if (n.sub)
      out += text(x + w / 2, ty - 1, n.sub, {
        anchor: "middle",
        size: 9.5,
        cls: "sub",
      });
    out += `</g>`;
  }
  return out + `</svg>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Chain (an ordered gate list rendered as a single left-to-right pipeline)
// ─────────────────────────────────────────────────────────────────────────────

export interface ChainStep {
  label: string;
  sub?: string;
  accent?: boolean;
  /** A side exit drawn below the step (e.g. "refused → security event"). */
  exit?: string;
}

export function renderChain(
  steps: ChainStep[],
  label: string,
  opts: { perRow?: number } = {},
): string {
  const perRow = opts.perRow ?? 5;
  const gx = 34;
  // Every box in a chain shares one width, wide enough for its longest label,
  // sub or exit, so no text spills past its box or into the next exit.
  const w = Math.ceil(
    Math.max(
      150,
      ...steps.map((s) =>
        Math.max(
          textWidth(s.label, 12) + 20,
          s.sub ? textWidth(s.sub, 9.5, true) + 16 : 0,
          s.exit ? textWidth(s.exit, 9.5) - gx + 8 : 0,
        ),
      ),
    ),
  );
  const h = 44;
  const gy = 64;
  const rows = Math.ceil(steps.length / perRow);
  const W = 24 + Math.min(perRow, steps.length) * (w + gx) - gx;
  const H = 16 + rows * (h + gy) - gy + 30;
  let out = svgOpen(W, H, label, "chain");
  steps.forEach((s, i) => {
    const r = Math.floor(i / perRow);
    const c = i % perRow;
    const x = 12 + c * (w + gx);
    const y = 12 + r * (h + gy);
    if (i > 0) {
      if (c > 0)
        out += pathEl(
          `M${fmt(x - gx)},${fmt(y + h / 2)} L${fmt(x - 2)},${fmt(y + h / 2)}`,
        );
      else {
        const px = 12 + (perRow - 1) * (w + gx) + w / 2;
        const py = y - gy + h;
        out += pathEl(
          `M${fmt(px)},${fmt(py)} L${fmt(px)},${fmt(py + gy / 2)} L${fmt(x + w / 2)},${fmt(py + gy / 2)} L${fmt(x + w / 2)},${fmt(y - 2)}`,
        );
      }
    }
    out += `<g class="node${s.accent ? " accent" : ""}">`;
    out += rect(x, y, w, h, {
      r: 6,
      stroke: s.accent ? ACCENT : "currentColor",
      sw: s.accent ? 1.8 : 1,
    });
    out += text(x + w / 2, s.sub ? y + 18 : y + h / 2 + 4, s.label, {
      anchor: "middle",
      weight: 600,
      size: 12,
    });
    if (s.sub)
      out += text(x + w / 2, y + 33, s.sub, {
        anchor: "middle",
        size: 9.5,
        mono: true,
        cls: "sub",
      });
    out += `</g>`;
    if (s.exit) {
      out += pathEl(
        `M${fmt(x + w / 2)},${fmt(y + h)} L${fmt(x + w / 2)},${fmt(y + h + 18)}`,
        { thin: true, dashed: true },
      );
      out += text(x + w / 2, y + h + 30, s.exit, {
        anchor: "middle",
        size: 9.5,
        cls: "exit",
      });
    }
  });
  return out + `</svg>`;
}
