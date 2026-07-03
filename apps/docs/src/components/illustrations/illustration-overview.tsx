import { hexPoints, illustrationClassName } from "./hex-utils";

/**
 * Platform-overview hero: scattered knowledge-graph hex nodes converge into a
 * governed context window — the "free, not full" retrieval story that anchors
 * the docs landing page. Two lit hexes (retrieved entities) feed a token grid
 * where only a small, precise cluster is lit, echoing the landing page's
 * ContextWindow component in static line-art form.
 */

const FAINT_HEXES = [
  { cx: 56, cy: 62, r: 16 },
  { cx: 56, cy: 138, r: 16 },
  { cx: 122, cy: 62, r: 16 },
  { cx: 122, cy: 138, r: 16 },
];

const LIT_HEXES = [
  { cx: 89, cy: 100, r: 17 },
  { cx: 155, cy: 100, r: 17 },
];

const GRID_COLS = 12;
const GRID_ROWS = 5;
const CELL = 12;
const GAP = 2.5;
const ORIGIN_X = 322;
const ORIGIN_Y = 58;
const LIT_CELLS = new Set([
  1 * GRID_COLS + 6,
  2 * GRID_COLS + 5,
  2 * GRID_COLS + 6,
  2 * GRID_COLS + 7,
  3 * GRID_COLS + 6,
]);

export function IllustrationOverview({ className }: { className?: string }) {
  const cells = Array.from({ length: GRID_COLS * GRID_ROWS }, (_, i) => i);

  return (
    <svg
      role="img"
      viewBox="0 0 560 200"
      width="100%"
      height="auto"
      className={illustrationClassName(className)}
    >
      <title>Scattered knowledge-graph nodes converging into a governed context window</title>
      <defs>
        <linearGradient id="ill-overview-g1" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--_ember-gold, #fd9a4b)" />
          <stop offset="0.5" stopColor="var(--_ember-flame, #f07650)" />
          <stop offset="1" stopColor="var(--_ember-crimson, #eb5c5e)" />
        </linearGradient>
      </defs>

      {FAINT_HEXES.map((h, i) => (
        <polygon
          key={`faint-${i}`}
          points={hexPoints(h.cx, h.cy, h.r)}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          opacity={0.22}
        />
      ))}

      {LIT_HEXES.map((h, i) => (
        <polygon
          key={`lit-${i}`}
          points={hexPoints(h.cx, h.cy, h.r)}
          fill="url(#ill-overview-g1)"
          opacity={0.92}
        />
      ))}

      <path
        d="M104,96 Q220,60 316,72"
        fill="none"
        stroke="url(#ill-overview-g1)"
        strokeWidth={1.5}
        strokeLinecap="round"
        opacity={0.7}
      />
      <path
        d="M170,104 Q240,120 316,110"
        fill="none"
        stroke="url(#ill-overview-g1)"
        strokeWidth={1.5}
        strokeLinecap="round"
        opacity={0.7}
      />

      <rect
        x={302}
        y={40}
        width={224}
        height={122}
        rx={12}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        opacity={0.4}
      />

      {cells.map((i) => {
        const col = i % GRID_COLS;
        const row = Math.floor(i / GRID_COLS);
        const lit = LIT_CELLS.has(i);
        return (
          <rect
            key={i}
            x={ORIGIN_X + col * (CELL + GAP)}
            y={ORIGIN_Y + row * (CELL + GAP)}
            width={CELL}
            height={CELL}
            rx={2.5}
            fill={lit ? "url(#ill-overview-g1)" : "currentColor"}
            opacity={lit ? 0.9 : 0.1}
          />
        );
      })}
    </svg>
  );
}
