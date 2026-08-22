import { hexVertices, illustrationClassName } from "./hex-utils";

/**
 * Enterprise-overview hero: a root organization node branching into a set
 * of dotted workspace nodes, isolated from one another — only the branch
 * currently in view carries the single ember thread.
 */

const WORKSPACES = [
  { cy: 40, active: false },
  { cy: 80, active: true },
  { cy: 120, active: false },
  { cy: 160, active: false },
];

export function IllustrationEnterprise({ className }: { className?: string }) {
  return (
    <svg
      role="img"
      viewBox="0 0 560 200"
      className={illustrationClassName(className)}
    >
      <title>An organization branching into isolated workspace nodes</title>
      <defs>
        <linearGradient id="ill-enterprise-g1" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="var(--_ember-a, #A37200)" />
          <stop offset="1" stopColor="var(--_ember-c, #FFCB66)" />
        </linearGradient>
        <radialGradient id="ill-enterprise-glow">
          <stop
            offset="0"
            stopColor="var(--_ember-b, #FFB000)"
            stopOpacity={0.75}
          />
          <stop
            offset="1"
            stopColor="var(--_ember-b, #FFB000)"
            stopOpacity={0}
          />
        </radialGradient>
      </defs>

      <g opacity={0.34}>
        {hexVertices(100, 100, 24).map((p, j) => (
          <circle key={j} cx={p.x} cy={p.y} r={1.25} fill="currentColor" />
        ))}
      </g>

      {WORKSPACES.map((w, i) => (
        <path
          key={`line-${i}`}
          d={`M120,100 C220,100 220,${w.cy} 440,${w.cy}`}
          fill="none"
          stroke={w.active ? "url(#ill-enterprise-g1)" : "currentColor"}
          strokeWidth={w.active ? 1.25 : 1}
          strokeDasharray={w.active ? undefined : "0.5 6"}
          opacity={w.active ? 0.7 : 0.2}
        />
      ))}

      {WORKSPACES.map((w, i) => (
        <g key={`hex-${i}`} opacity={w.active ? 0.9 : 0.3}>
          {hexVertices(460, w.cy, 14).map((p, j) => (
            <circle key={j} cx={p.x} cy={p.y} r={1} fill="currentColor" />
          ))}
        </g>
      ))}
      <circle cx={460} cy={80} r={11} fill="url(#ill-enterprise-glow)" />

      <text
        x={100}
        y={140}
        textAnchor="middle"
        fontFamily="ui-monospace, SFMono-Regular, monospace"
        fontSize={10}
        fill="currentColor"
        opacity={0.4}
      >
        organization
      </text>
    </svg>
  );
}
