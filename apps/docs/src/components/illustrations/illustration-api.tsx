import { illustrationClassName } from "./hex-utils";

/**
 * API-overview hero: hairline REST braces around three versioned endpoints,
 * a quiet request/response pair passing between them, and a single ember
 * thread under the endpoint currently in flight.
 */

const ENDPOINTS = ["/v1/agent", "/v1/workflow", "/v1/knowledge"];

export function IllustrationApi({ className }: { className?: string }) {
  return (
    <svg
      role="img"
      viewBox="0 0 560 200"
      className={illustrationClassName(className)}
    >
      <title>
        REST braces framing versioned endpoints with a request in flight
      </title>
      <defs>
        <linearGradient id="ill-api-g1" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="var(--_ember-a, #A37200)" />
          <stop offset="1" stopColor="var(--_ember-c, #FFCB66)" />
        </linearGradient>
        <radialGradient id="ill-api-glow">
          <stop
            offset="0"
            stopColor="var(--_ember-b, #FFB000)"
            stopOpacity={0.8}
          />
          <stop
            offset="1"
            stopColor="var(--_ember-b, #FFB000)"
            stopOpacity={0}
          />
        </radialGradient>
      </defs>

      <path
        d="M100,38 Q80,38 80,58 L80,86 Q80,98 66,100 Q80,102 80,114 L80,142 Q80,162 100,162"
        fill="none"
        stroke="currentColor"
        strokeWidth={1}
        strokeLinecap="round"
        opacity={0.25}
      />
      <path
        d="M460,38 Q480,38 480,58 L480,86 Q480,98 494,100 Q480,102 480,114 L480,142 Q480,162 460,162"
        fill="none"
        stroke="currentColor"
        strokeWidth={1}
        strokeLinecap="round"
        opacity={0.25}
      />

      <path
        d="M160,54 L280,54"
        fill="none"
        stroke="currentColor"
        strokeWidth={1}
        strokeDasharray="0.5 5"
        strokeLinecap="round"
        opacity={0.3}
      />
      <circle cx={280} cy={54} r={8} fill="url(#ill-api-glow)" />
      <circle cx={280} cy={54} r={1.75} fill="url(#ill-api-g1)" />
      <path
        d="M280,74 L160,74"
        fill="none"
        stroke="currentColor"
        strokeWidth={1}
        strokeDasharray="0.5 5"
        strokeLinecap="round"
        opacity={0.22}
      />

      {ENDPOINTS.map((label, i) => (
        <g key={label}>
          <text
            x={168}
            y={116 + i * 20}
            fontFamily="ui-monospace, SFMono-Regular, monospace"
            fontSize={12}
            fill="currentColor"
            opacity={i === 0 ? 0.6 : 0.35}
          >
            {label}
          </text>
          <line
            x1={168}
            y1={121 + i * 20}
            x2={168 + label.length * 7.1}
            y2={121 + i * 20}
            stroke={i === 0 ? "url(#ill-api-g1)" : "currentColor"}
            strokeWidth={1}
            opacity={i === 0 ? 0.7 : 0.2}
          />
        </g>
      ))}
    </svg>
  );
}
