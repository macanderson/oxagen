import { z } from "zod";
import { registerCapability } from "../registry";

// Both value sets mirror the CHECK constraints on mcp.mcp_servers
// (packages/database/src/schema/mcp.ts). Plugin-installed servers are
// written with transport 'sse' and health 'unknown', so the list output has
// to admit every value the table can hold. The handler narrows each row
// through these same schemas.
export const mcpServerTransportType = z.enum([
  "streamable-http",
  "sse",
  "stdio",
]);
export const mcpServerHealthStatus = z.enum([
  "healthy",
  "degraded",
  "unreachable",
  "unknown",
]);

/**
 * How the workspace authenticates to a server. `oauth` comes from the
 * provider's listing; the rest are the server row's static strategy.
 */
export const mcpServerAuthKind = z.enum(["oauth", "bearer", "header", "none"]);

/**
 * An OAuth provider's stored authorization (#4132). `connected` holds an
 * access token; `needs_reauth` is what a refused refresh or a 401 at run time
 * leaves; `revoked` was revoked; `not_connected` has no token yet. The token
 * itself is never read here.
 */
export const mcpServerAuthorization = z.object({
  state: z.enum(["connected", "needs_reauth", "revoked", "not_connected"]),
  /** When the access token lapses, or null when the server gave no lifetime. */
  expiresAt: z.string().nullable(),
  /** A refresh token is held, so a lapsed access token renews without a person. */
  refreshable: z.boolean(),
  lastRefreshedAt: z.string().nullable(),
});

export const agentMcpList = registerCapability({
  name: "list_mcp_servers",
  domain: "agent",
  description:
    "List registered external MCP servers in the active workspace with their current health",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "introspection",
  },
  sensitivity: "low",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({}),
  output: z.object({
    servers: z.array(
      z.object({
        publicId: z.string(),
        name: z.string(),
        transportType: mcpServerTransportType,
        endpointUrl: z.string(),
        healthStatus: mcpServerHealthStatus,
        lastHealthcheckAt: z.string().nullable(),
        toolCount: z.number().int().nonnegative(),
        // Defaulted so a reader built before #4132 still parses.
        authKind: mcpServerAuthKind.default("none"),
        /** The provider's https icon, from the registry entry it was added from. */
        iconUrl: z.string().nullable().default(null),
        /** Null for a provider that does not use OAuth. */
        authorization: mcpServerAuthorization.nullable().default(null),
      }),
    ),
  }),
});

export type AgentMcpListInput = z.output<typeof agentMcpList.input>;
export type AgentMcpListOutput = z.output<typeof agentMcpList.output>;
