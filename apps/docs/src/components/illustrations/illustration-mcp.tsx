import { illustrationClassName } from "./hex-utils";

/**
 * MCP-overview hero: two hairline connector outlines meeting at a single
 * quiet point of contact — the protocol handshake between an MCP client
 * and the Oxagen tool surface, with the gradient touching only that point.
 */

export function IllustrationMcp({ className }: { className?: string }) {
  return (
    <svg
      role="img"
      viewBox="0 0 560 200"
      className={illustrationClassName(className)}
    >
      <title>
        Two connectors meeting at a single point, representing an MCP handshake
      </title>
      <defs>
        <linearGradient id="ill-mcp-g1" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="var(--_ember-gold, #F9D423)" />
          <stop offset="1" stopColor="var(--_ember-crimson, #C2185B)" />
        </linearGradient>
        <radialGradient id="ill-mcp-glow">
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

      <rect
        x={104}
        y={82}
        width={72}
        height={36}
        rx={7}
        fill="none"
        stroke="currentColor"
        strokeWidth={1}
        opacity={0.32}
      />
      <line
        x1={176}
        y1={92}
        x2={200}
        y2={92}
        stroke="currentColor"
        strokeWidth={1}
        opacity={0.32}
      />
      <line
        x1={176}
        y1={108}
        x2={200}
        y2={108}
        stroke="currentColor"
        strokeWidth={1}
        opacity={0.32}
      />

      <rect
        x={384}
        y={82}
        width={72}
        height={36}
        rx={7}
        fill="none"
        stroke="currentColor"
        strokeWidth={1}
        opacity={0.32}
      />
      <line
        x1={384}
        y1={92}
        x2={360}
        y2={92}
        stroke="currentColor"
        strokeWidth={1}
        opacity={0.22}
      />
      <line
        x1={384}
        y1={108}
        x2={360}
        y2={108}
        stroke="currentColor"
        strokeWidth={1}
        opacity={0.22}
      />

      <path
        d="M200,100 L360,100"
        fill="none"
        stroke="currentColor"
        strokeWidth={1}
        strokeDasharray="0.5 6"
        opacity={0.28}
      />

      <circle cx={280} cy={100} r={14} fill="url(#ill-mcp-glow)" />
      <path
        d="M262,100 L298,100"
        stroke="url(#ill-mcp-g1)"
        strokeWidth={1.5}
        strokeLinecap="round"
        opacity={0.85}
      />

      <text
        x={280}
        y={158}
        textAnchor="middle"
        fontFamily="ui-monospace, SFMono-Regular, monospace"
        fontSize={11}
        letterSpacing={2}
        fill="currentColor"
        opacity={0.35}
      >
        MCP
      </text>
    </svg>
  );
}
