import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * resolve_mcp_servers — return the active workspace's installed MCP servers
 * WITH their connection details and platform-resolved credentials, so a trusted
 * first-party client (the Oxagen CLI) can connect to them directly.
 *
 * This is the credential-bearing sibling of `list_mcp_servers` (which is
 * introspection-only, low sensitivity). Because it returns live secrets
 * (bearer tokens / auth headers the platform decrypted for this workspace) it
 * is `sensitivity: "high"`, deny-by-default, and restricted to workspace
 * members who are already entitled to use these servers in the app.
 *
 * The credential is resolved + decrypted SERVER-SIDE: the caller receives only
 * the final usable token/headers — never ciphertext, KMS keys, or (for oauth)
 * the refresh token. See packages/agent/src/handlers/agent.mcp.resolve.ts and
 * apps/cli/src/mcp/workspace-servers.ts for the end-to-end security rationale.
 */
export const agentMcpResolve = registerCapability({
  name: "resolve_mcp_servers",
  domain: "agent",
  description:
    "Resolve the active workspace's installed MCP servers with connection details and per-workspace credentials for first-party client use",
  mode: "sync",
  surfaces: ["api"],
  layers: ["schema", "api", "unit"],
  scoped: true,
  agent: {
    requiresApproval: false,
    riskLevel: "medium",
    category: "introspection",
  },
  sensitivity: "high",
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
        transportType: z.enum(["streamable-http", "stdio"]),
        endpointUrl: z.string(),
        /** Auth scheme the client should use with the returned credential. */
        authStrategy: z.enum(["none", "bearer", "header"]),
        /** How the credential was originally obtained (for diagnostics). */
        authKind: z.enum(["oauth", "secret", "none"]),
        /** Resolved bearer/access token, or null (none-auth or needs re-auth). */
        token: z.string().nullable(),
        /** Resolved auth headers for header-auth servers, or null. */
        headers: z.record(z.string()).nullable(),
        /** True when an oauth/secret server has no usable stored credential. */
        needsReauth: z.boolean(),
      }),
    ),
  }),
});

export type AgentMcpResolveInput = z.output<typeof agentMcpResolve.input>;
export type AgentMcpResolveOutput = z.output<typeof agentMcpResolve.output>;
