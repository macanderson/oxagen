import { illustrationClassName } from "./hex-utils";

/**
 * Plugins-overview hero: a row of hairline capability-pack contours, the one
 * currently installing outlined in a single thin ember thread, drifting
 * toward a dashed workspace socket.
 */

function puzzlePath(x: number, y: number, w: number, h: number): string {
  const bumpR = 6;
  return [
    `M${x},${y}`,
    `L${x + w * 0.4},${y}`,
    `Q${x + w * 0.5},${y} ${x + w * 0.5},${y - bumpR}`,
    `A${bumpR},${bumpR} 0 0 1 ${x + w * 0.5 + bumpR * 2},${y - bumpR}`,
    `Q${x + w * 0.5 + bumpR * 2},${y} ${x + w * 0.6 + bumpR * 2},${y}`,
    `L${x + w},${y}`,
    `L${x + w},${y + h}`,
    `L${x + w * 0.6 + bumpR * 2},${y + h}`,
    `Q${x + w * 0.5 + bumpR * 2},${y + h} ${x + w * 0.5 + bumpR * 2},${y + h + bumpR}`,
    `A${bumpR},${bumpR} 0 0 1 ${x + w * 0.5},${y + h + bumpR}`,
    `Q${x + w * 0.5},${y + h} ${x + w * 0.4},${y + h}`,
    `L${x},${y + h}`,
    `Z`,
  ].join(" ");
}

const PACKS = [50, 150, 250];

export function IllustrationPlugins({ className }: { className?: string }) {
  return (
    <svg
      role="img"
      viewBox="0 0 560 200"
      className={illustrationClassName(className)}
    >
      <title>
        Capability-pack contours, one drifting toward a workspace socket
      </title>
      <defs>
        <linearGradient id="ill-plugins-g1" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="var(--_ember-a, #725A00)" />
          <stop offset="1" stopColor="var(--_ember-c, #F7D96B)" />
        </linearGradient>
        <radialGradient id="ill-plugins-glow">
          <stop
            offset="0"
            stopColor="var(--_ember-b, #EFC53F)"
            stopOpacity={0.7}
          />
          <stop
            offset="1"
            stopColor="var(--_ember-b, #EFC53F)"
            stopOpacity={0}
          />
        </radialGradient>
      </defs>

      {PACKS.map((x) => (
        <path
          key={x}
          d={puzzlePath(x, 70, 70, 60)}
          fill="none"
          stroke="currentColor"
          strokeWidth={1}
          strokeLinejoin="round"
          opacity={0.24}
        />
      ))}

      <path
        d={puzzlePath(360, 70, 70, 60)}
        fill="none"
        stroke="url(#ill-plugins-g1)"
        strokeWidth={1.25}
        strokeLinejoin="round"
        opacity={0.75}
      />

      <path
        d="M436,100 L468,100"
        fill="none"
        stroke="currentColor"
        strokeWidth={1}
        strokeDasharray="0.5 5"
        strokeLinecap="round"
        opacity={0.3}
      />
      <circle cx={472} cy={100} r={9} fill="url(#ill-plugins-glow)" />

      <rect
        x={478}
        y={70}
        width={62}
        height={60}
        rx={8}
        fill="none"
        stroke="currentColor"
        strokeWidth={1}
        strokeDasharray="3 4"
        opacity={0.3}
      />

      <text
        x={509}
        y={150}
        textAnchor="middle"
        fontFamily="ui-monospace, SFMono-Regular, monospace"
        fontSize={10}
        fill="currentColor"
        opacity={0.35}
      >
        workspace
      </text>
    </svg>
  );
}
