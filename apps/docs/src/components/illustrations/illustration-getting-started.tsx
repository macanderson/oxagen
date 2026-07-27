import { hexEdgesPath, hexVertices, illustrationClassName } from "./hex-utils";

/**
 * Getting-started hero: a single dotted path drifting left to right, marked
 * by three quiet way-points (sign up, organization, workspace). Only the
 * middle way-point — the step that creates lasting state — carries the
 * ember thread; the rest stay neutral line-art.
 */

const WORKSPACE_HEXES = [
  { cx: 452, cy: 92, r: 11 },
  { cx: 480, cy: 108, r: 11 },
  { cx: 452, cy: 124, r: 11 },
];

export function IllustrationGettingStarted({
  className,
}: {
  className?: string;
}) {
  return (
    <svg
      role="img"
      viewBox="0 0 560 200"
      className={illustrationClassName(className)}
    >
      <title>A path drifting from sign-up to organization to workspace</title>
      <defs>
        <linearGradient id="ill-getting-started-g1" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="var(--_ember-gold, #F9D423)" />
          <stop offset="1" stopColor="var(--_ember-crimson, #C2185B)" />
        </linearGradient>
        <radialGradient id="ill-getting-started-glow">
          <stop
            offset="0"
            stopColor="var(--_ember-flame, #FF7E5F)"
            stopOpacity={0.8}
          />
          <stop
            offset="1"
            stopColor="var(--_ember-flame, #FF7E5F)"
            stopOpacity={0}
          />
        </radialGradient>
      </defs>

      <path
        d="M60,100 L500,100"
        fill="none"
        stroke="currentColor"
        strokeWidth={1}
        strokeDasharray="0.5 7"
        strokeLinecap="round"
        opacity={0.35}
      />

      {/* way-point 1 — sign up */}
      <path
        d="M62,90 L74,100 L62,110"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.25}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.4}
      />

      {/* way-point 2 — organization, the one lasting step */}
      <path
        d={hexEdgesPath(280, 100, 30, [4, 5, 0, 1])}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.25}
        strokeLinecap="round"
        opacity={0.3}
      />
      <path
        d={hexEdgesPath(280, 100, 30, [2, 3])}
        fill="none"
        stroke="url(#ill-getting-started-g1)"
        strokeWidth={1.25}
        strokeLinecap="round"
        opacity={0.85}
      />
      <circle cx={280} cy={100} r={14} fill="url(#ill-getting-started-glow)" />
      <circle cx={280} cy={100} r={2.5} fill="url(#ill-getting-started-g1)" />

      {/* way-point 3 — workspace, a loose cluster of dotted cells */}
      {WORKSPACE_HEXES.map((h, i) => (
        <g key={i} opacity={0.32}>
          {hexVertices(h.cx, h.cy, h.r).map((p, j) => (
            <circle key={j} cx={p.x} cy={p.y} r={1} fill="currentColor" />
          ))}
        </g>
      ))}

      <text
        x={68}
        y={140}
        textAnchor="middle"
        fontFamily="ui-monospace, SFMono-Regular, monospace"
        fontSize={10}
        fill="currentColor"
        opacity={0.4}
      >
        sign up
      </text>
      <text
        x={280}
        y={148}
        textAnchor="middle"
        fontFamily="ui-monospace, SFMono-Regular, monospace"
        fontSize={10}
        fill="currentColor"
        opacity={0.45}
      >
        organization
      </text>
      <text
        x={466}
        y={140}
        textAnchor="middle"
        fontFamily="ui-monospace, SFMono-Regular, monospace"
        fontSize={10}
        fill="currentColor"
        opacity={0.4}
      >
        workspace
      </text>
    </svg>
  );
}
