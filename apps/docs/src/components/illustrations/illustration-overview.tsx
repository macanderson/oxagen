import { hexVertices, illustrationClassName } from "./hex-utils";

/**
 * Platform-overview hero: a faint, fading field of hex vertices — the
 * knowledge graph, sensed rather than drawn — resolving into a single
 * hairline hex and one soft ember node. The gradient appears exactly once,
 * in the thread that settles from the lattice into that node.
 */

const FIELD = [
  { cx: 36, cy: 46, r: 15 },
  { cx: 76, cy: 118, r: 19 },
  { cx: 126, cy: 58, r: 13 },
  { cx: 150, cy: 150, r: 17 },
  { cx: 198, cy: 36, r: 21 },
  { cx: 224, cy: 116, r: 15 },
  { cx: 330, cy: 142, r: 17 },
  { cx: 366, cy: 44, r: 13 },
  { cx: 408, cy: 112, r: 19 },
  { cx: 456, cy: 58, r: 15 },
  { cx: 498, cy: 128, r: 13 },
  { cx: 522, cy: 48, r: 17 },
];

const ANCHOR = { cx: 280, cy: 74, r: 25 };

export function IllustrationOverview({ className }: { className?: string }) {
  return (
    <svg
      role="img"
      viewBox="0 0 560 200"
      className={illustrationClassName(className)}
    >
      <title>
        A faint knowledge-graph lattice settling into one governed node
      </title>
      <defs>
        <linearGradient id="ill-overview-g1" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--_ember-gold, #F9D423)" />
          <stop offset="1" stopColor="var(--_ember-crimson, #C2185B)" />
        </linearGradient>
        <radialGradient id="ill-overview-glow">
          <stop
            offset="0"
            stopColor="var(--_ember-flame, #FF7E5F)"
            stopOpacity={0.85}
          />
          <stop
            offset="1"
            stopColor="var(--_ember-flame, #FF7E5F)"
            stopOpacity={0}
          />
        </radialGradient>
        <linearGradient id="ill-overview-fade" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#000" />
          <stop offset="0.18" stopColor="#fff" />
          <stop offset="0.82" stopColor="#fff" />
          <stop offset="1" stopColor="#000" />
        </linearGradient>
        <mask id="ill-overview-mask">
          <rect
            x={0}
            y={0}
            width={560}
            height={200}
            fill="url(#ill-overview-fade)"
          />
        </mask>
      </defs>

      <g mask="url(#ill-overview-mask)">
        {FIELD.map((h, i) => (
          <g key={i} opacity={0.3}>
            {hexVertices(h.cx, h.cy, h.r).map((p, j) => (
              <circle key={j} cx={p.x} cy={p.y} r={1} fill="currentColor" />
            ))}
          </g>
        ))}
      </g>

      <polygon
        points={hexVertices(ANCHOR.cx, ANCHOR.cy, ANCHOR.r)
          .map((p) => `${p.x},${p.y}`)
          .join(" ")}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.25}
        opacity={0.32}
      />

      <path
        d={`M${ANCHOR.cx},${ANCHOR.cy + ANCHOR.r} L${ANCHOR.cx},${ANCHOR.cy + 58}`}
        fill="none"
        stroke="url(#ill-overview-g1)"
        strokeWidth={1.25}
        strokeLinecap="round"
        opacity={0.75}
      />
      <circle
        cx={ANCHOR.cx}
        cy={ANCHOR.cy + 62}
        r={16}
        fill="url(#ill-overview-glow)"
      />
      <circle
        cx={ANCHOR.cx}
        cy={ANCHOR.cy + 62}
        r={3}
        fill="url(#ill-overview-g1)"
      />
    </svg>
  );
}
