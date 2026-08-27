import { hexVertices, illustrationClassName } from "./hex-utils";

/**
 * Small spot for the CLI installation page: a hairline arrow settling into
 * an open hex — the single ember thread marks the moment the binary lands.
 */

export function IllustrationCliInstallSpot({
  className,
}: {
  className?: string;
}) {
  return (
    <svg
      role="img"
      viewBox="0 0 560 120"
      className={illustrationClassName(className)}
    >
      <title>
        An arrow settling into an open hex, representing the CLI install landing
      </title>
      <defs>
        <linearGradient
          id="ill-cli-install-spot-g1"
          x1="0"
          y1="0"
          x2="0"
          y2="1"
        >
          <stop offset="0" stopColor="var(--_ember-a, #725A00)" />
          <stop offset="1" stopColor="var(--_ember-c, #F7D96B)" />
        </linearGradient>
        <radialGradient id="ill-cli-install-spot-glow">
          <stop
            offset="0"
            stopColor="var(--_ember-b, #EFC53F)"
            stopOpacity={0.75}
          />
          <stop
            offset="1"
            stopColor="var(--_ember-b, #EFC53F)"
            stopOpacity={0}
          />
        </radialGradient>
      </defs>

      <path
        d="M280,20 L280,58"
        fill="none"
        stroke="url(#ill-cli-install-spot-g1)"
        strokeWidth={1.25}
        strokeLinecap="round"
        opacity={0.75}
      />
      <path
        d="M270,50 L280,60 L290,50"
        fill="none"
        stroke="url(#ill-cli-install-spot-g1)"
        strokeWidth={1.25}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.75}
      />

      <circle cx={280} cy={78} r={12} fill="url(#ill-cli-install-spot-glow)" />
      <g opacity={0.4}>
        {hexVertices(280, 78, 22).map((p, j) => (
          <circle key={j} cx={p.x} cy={p.y} r={1} fill="currentColor" />
        ))}
      </g>
    </svg>
  );
}
