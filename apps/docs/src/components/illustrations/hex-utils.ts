/**
 * Shared hexagon point-generation for the doc illustrations. Mirrors the
 * pointy-top orientation used by the Oxagen logomark (see
 * @oxagen/ui/components/hex-field) so every hex motif across the docs reads
 * as the same lattice.
 */
export function hexPoints(cx: number, cy: number, r: number): string {
  const pts: string[] = [];
  for (let k = 0; k < 6; k++) {
    const a = ((60 * k - 90) * Math.PI) / 180;
    pts.push(`${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`);
  }
  return pts.join(" ");
}

/** Joins a fixed base class with an optional caller-supplied className. */
export function illustrationClassName(className?: string): string {
  return className ? `text-foreground ${className}` : "text-foreground";
}
