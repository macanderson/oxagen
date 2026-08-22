import type { CSSProperties } from "react";

/**
 * HexField — an ambient background of hexagon cells abstracted from the Oxagen
 * logomark (the ember hex-cluster). Most cells are faint outlines ("faint");
 * a few are lit with the ember gradient and breathe slowly ("lit"), and a
 * couple glow cool indigo ("cool"). Used as a pointer-events-none backdrop
 * behind hero / auth / shell surfaces so every section reads as part of the
 * same lattice without competing with the foreground content.
 *
 * Pure presentational + deterministic (a fixed cell table, no randomness) so it
 * renders in a Server Component with zero hydration drift. Lit cells carry the
 * `.ox-hex-lit` class (defined in @oxagen/ui/styles/globals.css) for the slow
 * breathing pulse; the field itself is positioned/animated by the caller.
 *
 * Canonical, shared source: apps consume this via
 * `@oxagen/ui/components/hex-field`. The docs landing page and the app hero
 * backdrop both render this exact field so they stay visually identical.
 */

type Variant = "faint" | "lit" | "cool";

interface Cell {
  cx: number;
  cy: number;
  r: number;
  variant: Variant;
  /** animation phase offset (s) so lit cells breathe out of sync */
  delay?: number;
}

/** Pointy-top hexagon points (matches the logomark cell orientation). */
function hexPoints(cx: number, cy: number, r: number): string {
  const pts: string[] = [];
  for (let k = 0; k < 6; k++) {
    const a = ((60 * k - 90) * Math.PI) / 180;
    pts.push(
      `${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`,
    );
  }
  return pts.join(" ");
}

// A loose constellation across a 1200×600 field — echoes the logomark's
// scattered cluster rather than a dense honeycomb.
const FIELD: Cell[] = [
  { cx: 90, cy: 110, r: 30, variant: "faint" },
  { cx: 150, cy: 210, r: 30, variant: "faint" },
  { cx: 90, cy: 310, r: 30, variant: "faint" },
  { cx: 210, cy: 110, r: 30, variant: "faint" },
  { cx: 210, cy: 310, r: 30, variant: "faint" },
  { cx: 270, cy: 210, r: 30, variant: "faint" },
  { cx: 270, cy: 410, r: 30, variant: "faint" },
  { cx: 330, cy: 110, r: 30, variant: "faint" },
  { cx: 1110, cy: 130, r: 32, variant: "faint" },
  { cx: 1050, cy: 230, r: 32, variant: "lit", delay: 2.1 },
  { cx: 1110, cy: 330, r: 32, variant: "faint" },
  { cx: 990, cy: 130, r: 32, variant: "faint" },
  { cx: 990, cy: 330, r: 32, variant: "cool", delay: 3.0 },
  { cx: 930, cy: 230, r: 32, variant: "faint" },
  { cx: 930, cy: 430, r: 32, variant: "faint" },
  { cx: 1050, cy: 430, r: 32, variant: "faint" },
  { cx: 600, cy: 40, r: 22, variant: "faint" },
  { cx: 660, cy: 540, r: 22, variant: "lit", delay: 4.2 },
  { cx: 540, cy: 540, r: 22, variant: "faint" },
];

export function HexField({
  className,
  style,
}: {
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 1200 600"
      preserveAspectRatio="xMidYMid slice"
      className={className}
      style={style}
    >
      <defs>
        <linearGradient id="oxHexEmber" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#A37200" />
          <stop offset="0.5" stopColor="#FFB000" />
          <stop offset="1" stopColor="#FFCB66" />
        </linearGradient>
      </defs>
      {FIELD.map((c, i) => {
        const pts = hexPoints(c.cx, c.cy, c.r);
        if (c.variant === "faint") {
          return (
            <polygon
              key={i}
              points={pts}
              fill="none"
              stroke="currentColor"
              strokeWidth={1}
              opacity={0.14}
            />
          );
        }
        const fill =
          c.variant === "lit"
            ? "url(#oxHexEmber)"
            : "var(--ox-indigo-bright, #9CA3E8)";
        return (
          <polygon
            key={i}
            points={pts}
            fill={fill}
            className="ox-hex-lit"
            style={{ animationDelay: `${c.delay ?? 0}s` }}
          />
        );
      })}
    </svg>
  );
}
