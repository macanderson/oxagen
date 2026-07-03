import { hexPoints, illustrationClassName } from "./hex-utils";

/**
 * Security-overview hero: a shield over a faint hex lattice, a padlock at
 * its core, and a row of tenant rows below with one boundary highlighted —
 * the row-level-security enforcement point the page describes.
 */

const LATTICE_HEXES = [
  { cx: 40, cy: 40, r: 20 },
  { cx: 78, cy: 90, r: 20 },
  { cx: 40, cy: 140, r: 20 },
  { cx: 520, cy: 40, r: 20 },
  { cx: 482, cy: 90, r: 20 },
  { cx: 520, cy: 140, r: 20 },
];

const ROWS = 5;

export function IllustrationSecurity({ className }: { className?: string }) {
  return (
    <svg
      role="img"
      viewBox="0 0 560 200"
      className={illustrationClassName(className)}
    >
      <title>A shield with a padlock over a row-level security boundary</title>
      <defs>
        <linearGradient id="ill-security-g1" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--_ember-gold, #fd9a4b)" />
          <stop offset="0.5" stopColor="var(--_ember-flame, #f07650)" />
          <stop offset="1" stopColor="var(--_ember-crimson, #eb5c5e)" />
        </linearGradient>
      </defs>

      {LATTICE_HEXES.map((h, i) => (
        <polygon
          key={i}
          points={hexPoints(h.cx, h.cy, h.r)}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          opacity={0.14}
        />
      ))}

      {/* shield */}
      <path
        d="M280,26 L326,44 L326,86 Q326,132 280,156 Q234,132 234,86 L234,44 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinejoin="round"
        opacity={0.55}
      />

      {/* padlock */}
      <path
        d="M266,80 L266,68 Q266,54 280,54 Q294,54 294,68 L294,80"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        opacity={0.7}
      />
      <rect x={258} y={80} width={44} height={34} rx={6} fill="url(#ill-security-g1)" opacity={0.92} />
      <circle cx={280} cy={94} r={4} fill="var(--background, #fff)" opacity={0.9} />
      <rect x={278} y={96} width={4} height={10} rx={1.5} fill="var(--background, #fff)" opacity={0.9} />

      {/* tenant rows with the enforced boundary highlighted */}
      {Array.from({ length: ROWS }, (_, i) => {
        const enforced = i === 2;
        const x = 160 + i * 50;
        return (
          <rect
            key={`row-${i}`}
            x={x}
            y={178}
            width={40}
            height={14}
            rx={3}
            fill="none"
            stroke={enforced ? "url(#ill-security-g1)" : "currentColor"}
            strokeWidth={1.5}
            opacity={enforced ? 0.95 : 0.25}
          />
        );
      })}
    </svg>
  );
}
