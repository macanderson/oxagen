import { hexPoints, illustrationClassName } from "./hex-utils";

/**
 * Agent-overview hero: a central agent hex-head orchestrating a ring of tool
 * hexes over thin connector lines — every tool call still passes through the
 * same `invoke()` boundary as the surrounding lines suggest.
 */

const TOOL_HEXES = [
  { cx: 130, cy: 56, r: 15, lit: true },
  { cx: 100, cy: 110, r: 15, lit: false },
  { cx: 148, cy: 156, r: 15, lit: false },
  { cx: 412, cy: 56, r: 15, lit: false },
  { cx: 440, cy: 112, r: 15, lit: true },
  { cx: 400, cy: 158, r: 15, lit: false },
];

export function IllustrationAgent({ className }: { className?: string }) {
  return (
    <svg
      role="img"
      viewBox="0 0 560 200"
      width="100%"
      height="auto"
      className={illustrationClassName(className)}
    >
      <title>A central agent node orchestrating a ring of tool nodes</title>
      <defs>
        <linearGradient id="ill-agent-g1" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--_ember-gold, #fd9a4b)" />
          <stop offset="0.5" stopColor="var(--_ember-flame, #f07650)" />
          <stop offset="1" stopColor="var(--_ember-crimson, #eb5c5e)" />
        </linearGradient>
      </defs>

      {TOOL_HEXES.map((h, i) => (
        <path
          key={`line-${i}`}
          d={`M${h.cx},${h.cy} L280,100`}
          stroke="currentColor"
          strokeWidth={1.5}
          opacity={h.lit ? 0.4 : 0.2}
        />
      ))}

      {TOOL_HEXES.map((h, i) => (
        <polygon
          key={`hex-${i}`}
          points={hexPoints(h.cx, h.cy, h.r)}
          fill={h.lit ? "url(#ill-agent-g1)" : "none"}
          stroke={h.lit ? "none" : "currentColor"}
          strokeWidth={1.5}
          opacity={h.lit ? 0.9 : 0.35}
        />
      ))}

      {/* agent head */}
      <polygon
        points={hexPoints(280, 100, 38)}
        fill="none"
        stroke="url(#ill-agent-g1)"
        strokeWidth={2}
      />
      <line x1={280} y1={62} x2={280} y2={46} stroke="currentColor" strokeWidth={1.5} opacity={0.6} />
      <circle cx={280} cy={42} r={4} fill="url(#ill-agent-g1)" />
      <rect x={266} y={92} width={8} height={10} rx={2} fill="currentColor" opacity={0.7} />
      <rect x={286} y={92} width={8} height={10} rx={2} fill="currentColor" opacity={0.7} />
      <path
        d="M266,116 Q280,124 294,116"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        opacity={0.7}
      />
    </svg>
  );
}
