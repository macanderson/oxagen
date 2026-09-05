import { hexEdgesPath, hexVertices, illustrationClassName } from "./hex-utils";

/**
 * Agent-overview hero: a dotted agent hex at center with a loose ring of
 * dotted tool hexes around it. Every connector is a hairline except the one
 * currently in use, which carries the single ember thread to a soft-lit
 * tool node — the one call passing through `invoke()` right now.
 */

const TOOL_HEXES = [
  { cx: 130, cy: 56, r: 12 },
  { cx: 100, cy: 116, r: 12 },
  { cx: 152, cy: 160, r: 12 },
  { cx: 412, cy: 56, r: 12 },
  { cx: 440, cy: 118, r: 12, active: true },
  { cx: 402, cy: 160, r: 12 },
];

export function IllustrationAgent({ className }: { className?: string }) {
  return (
    <svg
      role="img"
      viewBox="0 0 560 200"
      className={illustrationClassName(className)}
    >
      <title>
        An agent node orchestrating a ring of tool nodes over a single active
        thread
      </title>
      <defs>
        <linearGradient id="ill-agent-g1" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="var(--_ember-a, #725A00)" />
          <stop offset="1" stopColor="var(--_ember-c, #F7D96B)" />
        </linearGradient>
        <radialGradient id="ill-agent-glow">
          <stop
            offset="0"
            stopColor="var(--_ember-b, #EFC53F)"
            stopOpacity={0.8}
          />
          <stop
            offset="1"
            stopColor="var(--_ember-b, #EFC53F)"
            stopOpacity={0}
          />
        </radialGradient>
      </defs>

      {TOOL_HEXES.map((h, i) => (
        <path
          key={`line-${i}`}
          d={`M${h.cx},${h.cy} L280,100`}
          stroke={h.active ? "url(#ill-agent-g1)" : "currentColor"}
          strokeWidth={h.active ? 1.25 : 1}
          strokeDasharray={h.active ? undefined : "0.5 6"}
          opacity={h.active ? 0.75 : 0.2}
        />
      ))}

      {TOOL_HEXES.map((h, i) => (
        <g key={`hex-${i}`} opacity={h.active ? 0.9 : 0.32}>
          {hexVertices(h.cx, h.cy, h.r).map((p, j) => (
            <circle key={j} cx={p.x} cy={p.y} r={1} fill="currentColor" />
          ))}
        </g>
      ))}
      <circle cx={440} cy={118} r={11} fill="url(#ill-agent-glow)" />

      {/* agent head */}
      <g opacity={0.34}>
        {hexVertices(280, 100, 34).map((p, j) => (
          <circle key={j} cx={p.x} cy={p.y} r={1.25} fill="currentColor" />
        ))}
      </g>
      <path
        d={hexEdgesPath(280, 100, 34, [5, 0])}
        fill="none"
        stroke="url(#ill-agent-g1)"
        strokeWidth={1.25}
        strokeLinecap="round"
        opacity={0.6}
      />
    </svg>
  );
}
