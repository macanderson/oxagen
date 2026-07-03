import { illustrationClassName } from "./hex-utils";

/**
 * MCP-overview hero: a plug and socket meeting at center with an ember spark
 * — the protocol handshake between an MCP client (Claude Code, Cursor, …)
 * and the Oxagen tool surface.
 */

export function IllustrationMcp({ className }: { className?: string }) {
  return (
    <svg
      role="img"
      viewBox="0 0 560 200"
      width="100%"
      height="auto"
      className={illustrationClassName(className)}
    >
      <title>A plug and socket meeting at center, representing an MCP protocol handshake</title>
      <defs>
        <linearGradient id="ill-mcp-g1" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--_ember-gold, #fd9a4b)" />
          <stop offset="0.5" stopColor="var(--_ember-flame, #f07650)" />
          <stop offset="1" stopColor="var(--_ember-crimson, #eb5c5e)" />
        </linearGradient>
        <radialGradient id="ill-mcp-g2">
          <stop offset="0" stopColor="var(--_ember-gold, #fd9a4b)" stopOpacity={0.9} />
          <stop offset="1" stopColor="var(--_ember-crimson, #eb5c5e)" stopOpacity={0} />
        </radialGradient>
      </defs>

      {/* plug (client) */}
      <rect
        x={70}
        y={78}
        width={90}
        height={44}
        rx={8}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        opacity={0.55}
      />
      <rect x={160} y={88} width={26} height={8} rx={2} fill="currentColor" opacity={0.55} />
      <rect x={160} y={104} width={26} height={8} rx={2} fill="currentColor" opacity={0.55} />
      <rect x={186} y={88} width={44} height={8} rx={2} fill="url(#ill-mcp-g1)" opacity={0.9} />
      <rect x={186} y={104} width={44} height={8} rx={2} fill="url(#ill-mcp-g1)" opacity={0.9} />

      {/* socket (Oxagen MCP server) */}
      <rect
        x={400}
        y={78}
        width={90}
        height={44}
        rx={8}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        opacity={0.55}
      />
      <rect x={374} y={88} width={26} height={8} rx={2} fill="none" stroke="currentColor" strokeWidth={1.5} opacity={0.4} />
      <rect x={374} y={104} width={26} height={8} rx={2} fill="none" stroke="currentColor" strokeWidth={1.5} opacity={0.4} />

      {/* handshake spark at the point of contact */}
      <circle cx={280} cy={100} r={30} fill="url(#ill-mcp-g2)" opacity={0.7} />
      <circle cx={280} cy={100} r={5} fill="url(#ill-mcp-g1)" />
      <path
        d="M258,100 L230,100 M302,100 L330,100 M280,78 L280,58 M280,122 L280,142"
        stroke="url(#ill-mcp-g1)"
        strokeWidth={1.5}
        strokeLinecap="round"
        opacity={0.55}
      />

      <text
        x={280}
        y={168}
        textAnchor="middle"
        fontFamily="ui-monospace, SFMono-Regular, monospace"
        fontSize={12}
        letterSpacing={2}
        fill="currentColor"
        opacity={0.5}
      >
        MCP
      </text>
    </svg>
  );
}
