import { hexVertices, illustrationClassName } from "./hex-utils";

/**
 * Small spot for connector pages (GitHub, etc.): three hairline branches
 * merging into a single dotted hex — a repository's history folding into
 * the knowledge graph. The single ember thread lives only at the merge.
 */

export function IllustrationConnectionSpot({
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
      <title>Three branches merging into a knowledge-graph node</title>
      <defs>
        <linearGradient id="ill-connection-spot-g1" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="var(--_ember-gold, #F9D423)" />
          <stop offset="1" stopColor="var(--_ember-crimson, #C2185B)" />
        </linearGradient>
        <radialGradient id="ill-connection-spot-glow">
          <stop
            offset="0"
            stopColor="var(--_ember-flame, #FF7E5F)"
            stopOpacity={0.75}
          />
          <stop
            offset="1"
            stopColor="var(--_ember-flame, #FF7E5F)"
            stopOpacity={0}
          />
        </radialGradient>
      </defs>

      <path
        d="M140,30 C220,30 220,58 280,58"
        fill="none"
        stroke="currentColor"
        strokeWidth={1}
        opacity={0.28}
      />
      <path
        d="M140,60 L280,60"
        fill="none"
        stroke="currentColor"
        strokeWidth={1}
        opacity={0.28}
      />
      <path
        d="M140,90 C220,90 220,62 280,62"
        fill="none"
        stroke="currentColor"
        strokeWidth={1}
        opacity={0.28}
      />
      <circle cx={140} cy={30} r={2.5} fill="currentColor" opacity={0.35} />
      <circle cx={140} cy={60} r={2.5} fill="currentColor" opacity={0.35} />
      <circle cx={140} cy={90} r={2.5} fill="currentColor" opacity={0.35} />

      <path
        d="M280,60 L390,60"
        fill="none"
        stroke="url(#ill-connection-spot-g1)"
        strokeWidth={1.25}
        opacity={0.7}
      />
      <circle cx={410} cy={60} r={12} fill="url(#ill-connection-spot-glow)" />
      <g opacity={0.5}>
        {hexVertices(410, 60, 20).map((p, j) => (
          <circle key={j} cx={p.x} cy={p.y} r={1} fill="currentColor" />
        ))}
      </g>
    </svg>
  );
}
