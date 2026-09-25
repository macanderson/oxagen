import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * The OAuth app a workspace brings for a server that registers no clients
 * itself (Slack, GitHub), or for its own internal server. The secret is
 * envelope-encrypted with the connection and never returned.
 */
export const mcpOAuthClient = z.object({
  clientId: z.string().trim().min(1).max(400),
  clientSecret: z.string().trim().min(1).max(4000).optional(),
  /** Space-separated scopes to request; absent requests what the server advertises. */
  scopes: z.string().trim().max(4000).optional(),
});

export const agentMcpAuthorizeStart = registerCapability({
  name: "start_mcp_authorization",
  domain: "agent",
  description:
    "Start OAuth authorization for an MCP server: a new provider from the registry or a custom endpoint, or a reconnect of one already added. Returns the URL the person signs in at",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow" },
  },
  // A reconnect names `mcpServerId`; an add names `name` and `endpointUrl`.
  // The handler refuses an input with neither, since a refinement would hide
  // the object shape the MCP tool schema is built from.
  input: z.object({
    /** Reconnect this provider (`mcs_…`) instead of adding one. */
    mcpServerId: z.string().min(1).optional(),
    name: z.string().trim().min(1).max(120).optional(),
    endpointUrl: z.string().url().optional(),
    description: z.string().max(500).optional(),
    iconUrl: z.string().url().optional(),
    /** The registry id the provider was picked from (`app.linear/linear`, `verified/slack`). */
    registryId: z.string().max(300).optional(),
    client: mcpOAuthClient.optional(),
    /** The app's callback, `<origin>/api/v1/mcp/oauth/callback`. */
    redirectUrl: z.string().url(),
  }),
  output: z.discriminatedUnion("status", [
    z.object({
      status: z.literal("redirect"),
      /** Where the person signs in. It carries `state`. */
      authorizationUrl: z.string(),
      state: z.string(),
    }),
    z.object({
      status: z.literal("authorized"),
      mcpServerId: z.string(),
      healthStatus: z.enum(["healthy", "degraded", "unreachable"]),
      discoveredTools: z.array(z.string()),
    }),
    z.object({
      /** The server registers no clients and none was supplied: bring an OAuth app. */
      status: z.literal("client_required"),
      scopesSupported: z.array(z.string()),
    }),
    z.object({
      /** The endpoint asks for no OAuth; add it with `register_mcp_server`. */
      status: z.literal("not_oauth"),
    }),
  ]),
});

export type AgentMcpAuthorizeStartInput = z.output<
  typeof agentMcpAuthorizeStart.input
>;
export type AgentMcpAuthorizeStartOutput = z.output<
  typeof agentMcpAuthorizeStart.output
>;
