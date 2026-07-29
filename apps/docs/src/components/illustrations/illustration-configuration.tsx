import { illustrationClassName } from "./hex-utils";

/**
 * Configuration hero: a row of hairline toggle tracks, three at rest and
 * one set — the single ember thread lives only in the knob and track fill
 * of the active control, echoing env vars validated at startup.
 */

const TOGGLES = [
  { x: 90, on: false },
  { x: 210, on: true },
  { x: 330, on: false },
  { x: 450, on: false },
];

export function IllustrationConfiguration({
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
      <title>A row of configuration toggles with one set</title>
      <defs>
        <linearGradient id="ill-configuration-g1" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="var(--_ember-gold, #F9D423)" />
          <stop offset="1" stopColor="var(--_ember-crimson, #C2185B)" />
        </linearGradient>
        <radialGradient id="ill-configuration-glow">
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

      {TOGGLES.map((t, i) => (
        <g key={i}>
          <rect
            x={t.x}
            y={92}
            width={44}
            height={16}
            rx={8}
            fill="none"
            stroke={t.on ? "url(#ill-configuration-g1)" : "currentColor"}
            strokeWidth={1}
            opacity={t.on ? 0.6 : 0.25}
          />
          {t.on && (
            <circle
              cx={t.x + 12}
              cy={100}
              r={10}
              fill="url(#ill-configuration-glow)"
            />
          )}
          <circle
            cx={t.on ? t.x + 32 : t.x + 12}
            cy={100}
            r={5}
            fill={t.on ? "url(#ill-configuration-g1)" : "currentColor"}
            opacity={t.on ? 0.95 : 0.3}
          />
          <line
            x1={t.x + 22}
            y1={70}
            x2={t.x + 22}
            y2={80}
            stroke="currentColor"
            strokeWidth={1}
            opacity={0.2}
          />
        </g>
      ))}
    </svg>
  );
}
