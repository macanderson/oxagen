import { illustrationClassName } from "./hex-utils";

/**
 * API-overview hero: REST braces framing three versioned endpoint pills,
 * with a request arrow flowing in and a dashed response arrow flowing back
 * out — the request/response shape every `/v1/*` route follows.
 */

const ENDPOINTS = ["/v1/agent", "/v1/workflow", "/v1/knowledge"];

export function IllustrationApi({ className }: { className?: string }) {
  return (
    <svg
      role="img"
      viewBox="0 0 560 200"
      width="100%"
      height="auto"
      className={illustrationClassName(className)}
    >
      <title>REST braces framing versioned endpoints with request and response arrows</title>
      <defs>
        <linearGradient id="ill-api-g1" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--_ember-gold, #fd9a4b)" />
          <stop offset="0.5" stopColor="var(--_ember-flame, #f07650)" />
          <stop offset="1" stopColor="var(--_ember-crimson, #eb5c5e)" />
        </linearGradient>
      </defs>

      {/* left brace */}
      <path
        d="M96,36 Q72,36 72,60 L72,88 Q72,100 58,100 Q72,100 72,112 L72,140 Q72,164 96,164"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.5}
        strokeLinecap="round"
        opacity={0.45}
      />
      {/* right brace */}
      <path
        d="M464,36 Q488,36 488,60 L488,88 Q488,100 502,100 Q488,100 488,112 L488,140 Q488,164 464,164"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.5}
        strokeLinecap="round"
        opacity={0.45}
      />

      {/* client -> API request */}
      <text
        x={190}
        y={44}
        fontFamily="ui-monospace, SFMono-Regular, monospace"
        fontSize={11}
        fill="currentColor"
        opacity={0.5}
      >
        client
      </text>
      <path
        d="M150,52 L280,52"
        fill="none"
        stroke="url(#ill-api-g1)"
        strokeWidth={1.5}
        strokeLinecap="round"
      />
      <path
        d="M272,45 L282,52 L272,59"
        fill="none"
        stroke="url(#ill-api-g1)"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <text
        x={215}
        y={44}
        textAnchor="middle"
        fontFamily="ui-monospace, SFMono-Regular, monospace"
        fontSize={10}
        fill="url(#ill-api-g1)"
        opacity={0.9}
      >
        POST
      </text>
      <text
        x={380}
        y={44}
        textAnchor="end"
        fontFamily="ui-monospace, SFMono-Regular, monospace"
        fontSize={11}
        fill="currentColor"
        opacity={0.5}
      >
        api.oxagen.sh
      </text>

      {/* API -> client response */}
      <path
        d="M280,74 L150,74"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeDasharray="4 5"
        strokeLinecap="round"
        opacity={0.4}
      />
      <path
        d="M158,67 L148,74 L158,81"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.4}
      />
      <text
        x={215}
        y={90}
        textAnchor="middle"
        fontFamily="ui-monospace, SFMono-Regular, monospace"
        fontSize={10}
        fill="currentColor"
        opacity={0.4}
      >
        200 OK
      </text>

      {ENDPOINTS.map((label, i) => (
        <g key={label}>
          <rect
            x={148}
            y={108 + i * 20}
            width={264}
            height={16}
            rx={8}
            fill="none"
            stroke={i === 0 ? "url(#ill-api-g1)" : "currentColor"}
            strokeWidth={1.5}
            opacity={i === 0 ? 0.85 : 0.3}
          />
          <text
            x={162}
            y={120 + i * 20}
            fontFamily="ui-monospace, SFMono-Regular, monospace"
            fontSize={11}
            fill="currentColor"
            opacity={i === 0 ? 0.9 : 0.55}
          >
            {label}
          </text>
        </g>
      ))}
    </svg>
  );
}
