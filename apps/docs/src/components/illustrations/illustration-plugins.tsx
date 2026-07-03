import { illustrationClassName } from "./hex-utils";

/**
 * Plugins-overview hero: a row of capability-pack puzzle blocks, one lit and
 * sliding into a dashed workspace socket — a plugin is installed into a
 * single workspace, not switched on globally.
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

const PACKS = [
  { x: 50, lit: false },
  { x: 150, lit: false },
  { x: 250, lit: false },
];

export function IllustrationPlugins({ className }: { className?: string }) {
  return (
    <svg
      role="img"
      viewBox="0 0 560 200"
      width="100%"
      height="auto"
      className={illustrationClassName(className)}
    >
      <title>Capability-pack blocks, one sliding into a workspace socket</title>
      <defs>
        <linearGradient id="ill-plugins-g1" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--_ember-gold, #fd9a4b)" />
          <stop offset="0.5" stopColor="var(--_ember-flame, #f07650)" />
          <stop offset="1" stopColor="var(--_ember-crimson, #eb5c5e)" />
        </linearGradient>
      </defs>

      {PACKS.map((p) => (
        <path
          key={p.x}
          d={puzzlePath(p.x, 70, 70, 60)}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinejoin="round"
          opacity={0.32}
        />
      ))}

      {/* the active pack, mid-slide toward the workspace socket */}
      <path
        d={puzzlePath(360, 70, 70, 60)}
        fill="url(#ill-plugins-g1)"
        stroke="none"
        opacity={0.92}
      />

      <path
        d="M436,100 L470,100"
        fill="none"
        stroke="url(#ill-plugins-g1)"
        strokeWidth={1.5}
        strokeDasharray="3 4"
        strokeLinecap="round"
        opacity={0.7}
      />
      <path
        d="M462,93 L472,100 L462,107"
        fill="none"
        stroke="url(#ill-plugins-g1)"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.7}
      />

      {/* workspace socket, dashed to read as the receiving slot */}
      <rect
        x={478}
        y={70}
        width={62}
        height={60}
        rx={8}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeDasharray="4 4"
        opacity={0.45}
      />

      <text
        x={509}
        y={150}
        textAnchor="middle"
        fontFamily="ui-monospace, SFMono-Regular, monospace"
        fontSize={11}
        fill="currentColor"
        opacity={0.5}
      >
        workspace
      </text>
    </svg>
  );
}
