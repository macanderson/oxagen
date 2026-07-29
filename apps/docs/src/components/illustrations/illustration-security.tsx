import { hexVertices, illustrationClassName } from "./hex-utils";

/**
 * Security-overview hero: a fading dotted hex field behind a hairline shield
 * contour and a minimal lock — just a broken circle and a thin arc, no
 * filled body. Below, a row of tenant ticks with one boundary lit — the
 * single ember thread marking the row-level-security enforcement point.
 */

const LATTICE = [
  { cx: 40, cy: 40, r: 18 },
  { cx: 78, cy: 92, r: 18 },
  { cx: 40, cy: 144, r: 18 },
  { cx: 520, cy: 40, r: 18 },
  { cx: 482, cy: 92, r: 18 },
  { cx: 520, cy: 144, r: 18 },
];

const ROWS = 6;

export function IllustrationSecurity({ className }: { className?: string }) {
  return (
    <svg
      role="img"
      viewBox="0 0 560 200"
      className={illustrationClassName(className)}
    >
      <title>
        A shield and lock over a row-level security boundary, one row lit
      </title>
      <defs>
        <linearGradient id="ill-security-g1" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--_ember-gold, #F9D423)" />
          <stop offset="1" stopColor="var(--_ember-crimson, #C2185B)" />
        </linearGradient>
        <radialGradient id="ill-security-glow">
          <stop
            offset="0"
            stopColor="var(--_ember-flame, #FF7E5F)"
            stopOpacity={0.7}
          />
          <stop
            offset="1"
            stopColor="var(--_ember-flame, #FF7E5F)"
            stopOpacity={0}
          />
        </radialGradient>
        <linearGradient id="ill-security-fade" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#fff" />
          <stop offset="0.3" stopColor="#000" />
          <stop offset="0.7" stopColor="#000" />
          <stop offset="1" stopColor="#fff" />
        </linearGradient>
        <mask id="ill-security-mask">
          <rect
            x={0}
            y={0}
            width={560}
            height={200}
            fill="url(#ill-security-fade)"
          />
        </mask>
      </defs>

      <g mask="url(#ill-security-mask)">
        {LATTICE.map((h, i) => (
          <g key={i} opacity={0.28}>
            {hexVertices(h.cx, h.cy, h.r).map((p, j) => (
              <circle key={j} cx={p.x} cy={p.y} r={1} fill="currentColor" />
            ))}
          </g>
        ))}
      </g>

      <path
        d="M280,28 L318,44 L318,80 Q318,118 280,140 Q242,118 242,80 L242,44 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth={1}
        strokeLinejoin="round"
        opacity={0.3}
      />

      <circle
        cx={280}
        cy={82}
        r={16}
        fill="none"
        stroke="currentColor"
        strokeWidth={1}
        opacity={0.4}
      />
      <path
        d="M270,74 L270,66 Q270,56 280,56 Q290,56 290,66 L290,74"
        fill="none"
        stroke="currentColor"
        strokeWidth={1}
        strokeLinecap="round"
        opacity={0.4}
      />
      <circle cx={280} cy={82} r={9} fill="url(#ill-security-glow)" />
      <line
        x1={280}
        y1={82}
        x2={280}
        y2={98}
        stroke="url(#ill-security-g1)"
        strokeWidth={1.25}
        strokeLinecap="round"
        opacity={0.85}
      />

      {Array.from({ length: ROWS }, (_, i) => {
        const enforced = i === 3;
        const x = 130 + i * 46;
        return (
          <line
            key={i}
            x1={x}
            y1={168}
            x2={x + 30}
            y2={168}
            stroke={enforced ? "url(#ill-security-g1)" : "currentColor"}
            strokeWidth={enforced ? 1.5 : 1}
            strokeLinecap="round"
            opacity={enforced ? 0.85 : 0.22}
          />
        );
      })}
    </svg>
  );
}
