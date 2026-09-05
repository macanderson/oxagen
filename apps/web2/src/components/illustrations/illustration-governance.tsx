import { hexEdgesPath, illustrationClassName } from "./hex-utils";

/**
 * Governance-overview hero: three broken hex rings narrowing from
 * organization to workspace to principal — policy scope tightening inward —
 * with a single ember thread tracing the line of authority down to the
 * principal at the center.
 */

const CX = 280;
const CY = 100;

export function IllustrationGovernance({ className }: { className?: string }) {
  return (
    <svg
      role="img"
      viewBox="0 0 560 200"
      className={illustrationClassName(className)}
    >
      <title>
        Three nested policy scopes narrowing from organization to principal
      </title>
      <defs>
        <linearGradient id="ill-governance-g1" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor="var(--_ember-c, #F7D96B)" />
          <stop offset="1" stopColor="var(--_ember-a, #725A00)" />
        </linearGradient>
        <radialGradient id="ill-governance-glow">
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

      <path
        d={hexEdgesPath(CX, CY, 76, [0, 1, 2])}
        fill="none"
        stroke="currentColor"
        strokeWidth={1}
        strokeLinecap="round"
        opacity={0.26}
      />
      <path
        d={hexEdgesPath(CX, CY, 50, [2, 3, 4])}
        fill="none"
        stroke="currentColor"
        strokeWidth={1}
        strokeLinecap="round"
        opacity={0.3}
      />
      <path
        d={hexEdgesPath(CX, CY, 26, [4, 5, 0])}
        fill="none"
        stroke="currentColor"
        strokeWidth={1}
        strokeLinecap="round"
        opacity={0.34}
      />

      <path
        d={`M${CX},${CY - 76} L${CX},${CY - 8}`}
        fill="none"
        stroke="url(#ill-governance-g1)"
        strokeWidth={1.25}
        strokeLinecap="round"
        opacity={0.7}
      />
      <circle cx={CX} cy={CY} r={12} fill="url(#ill-governance-glow)" />
      <circle cx={CX} cy={CY} r={2.5} fill="url(#ill-governance-g1)" />

      <text
        x={CX}
        y={30}
        textAnchor="middle"
        fontFamily="ui-monospace, SFMono-Regular, monospace"
        fontSize={10}
        fill="currentColor"
        opacity={0.35}
      >
        organization
      </text>
      <text
        x={CX}
        y={182}
        textAnchor="middle"
        fontFamily="ui-monospace, SFMono-Regular, monospace"
        fontSize={10}
        fill="currentColor"
        opacity={0.4}
      >
        principal
      </text>
    </svg>
  );
}
