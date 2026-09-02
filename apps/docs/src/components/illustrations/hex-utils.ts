/**
 * Shared hexagon geometry for the doc illustrations. Mirrors the pointy-top
 * orientation used by the Oxagen logomark (see @oxagen/ui/components/hex-field)
 * so every hex motif across the docs reads as the same lattice — but these
 * illustrations lean on partial/broken contours and dotted vertices far more
 * than closed polygons, so the lattice reads as discovered rather than
 * stamped.
 */

export interface Point {
  x: number;
  y: number;
}

/** The six pointy-top vertices of a hex centered at (cx, cy) with radius r. */
export function hexVertices(cx: number, cy: number, r: number): Point[] {
  const pts: Point[] = [];
  for (let k = 0; k < 6; k++) {
    const a = ((60 * k - 90) * Math.PI) / 180;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}

/** `points` attribute string for a closed hex outline — for faint background fields. */
export function hexPoints(cx: number, cy: number, r: number): string {
  return hexVertices(cx, cy, r)
    .map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`)
    .join(" ");
}

/**
 * A `d` path drawing only a subset of the hex's six edges (0 = vertex[0]→[1],
 * … 5 = vertex[5]→[0]). Used for "broken" contours that feel like a fragment
 * of a lattice rather than a stamped cell.
 */
export function hexEdgesPath(
  cx: number,
  cy: number,
  r: number,
  edges: number[],
): string {
  const v = hexVertices(cx, cy, r);
  return edges
    .map((e) => {
      const from = ((e % 6) + 6) % 6;
      const to = (from + 1) % 6;
      const a = v[from] as Point;
      const b = v[to] as Point;
      return `M${a.x.toFixed(2)},${a.y.toFixed(2)} L${b.x.toFixed(2)},${b.y.toFixed(2)}`;
    })
    .join(" ");
}

/** Joins the fixed base classes with an optional caller-supplied className. */
export function illustrationClassName(className?: string): string {
  const base = "h-auto w-full text-foreground";
  return className ? `${base} ${className}` : base;
}
