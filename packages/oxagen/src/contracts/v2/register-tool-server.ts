import { z } from "zod";
import { defineTool } from "./_define";
import { agentMcpRegister } from "../agent.mcp.register";
import { agentMcpSetEnabled } from "../agent.mcp.set_enabled";

/**
 * Appendix E: `register_tool_server` — "MCP or HTTP server". Absorbs
 * `register_mcp_server` and `set_mcp_enabled`.
 *
 * Three carry decisions worth reading before the code:
 *
 * 1. **A tool server is no longer an MCP server.** Appendix A's
 *    `tools.tool_servers` splits what v1 conflated into two columns: `kind`
 *    (`mcp`, `http`, `harness`, `oxagen`) and `transport` (`streamable_http`,
 *    `stdio`, `openapi`, `builtin`). v1's single `transportType` enum could only
 *    describe an MCP server, so `kind` is new and `transportType` is carried by
 *    import and then widened — the two `streamable-http`/`stdio` members keep
 *    their v1 spelling so an existing row migrates without a rewrite.
 *
 * 2. **The credential does not travel with the registration.** v1 took
 *    `authConfig` — the bearer token or auth headers — inline. Pillar 12 (§6)
 *    is "the agent holds no credentials at all", and §6.7 step 5 brokers a
 *    per-call credential from `tools.connections`. So this tool declares *which*
 *    connection backs the server (`tools.tool_servers.connection_id`) and
 *    `set_connection` is the only thing that ever sees secret material.
 *
 * 3. **Register and enable are one call because they are one row.**
 *    `set_mcp_enabled` flipped `status` on an existing server; here `serverId`
 *    is optional, and its presence is what makes the call an update. That is
 *    also how a killed server is distinguished from a disabled one: Appendix A
 *    gives `status` three values, and `killed` is set by `set_kill_switch`
 *    (§6.13), never by this tool.
 */
export const registerToolServer = defineTool({
  name: "register_tool_server",
  domain: "tools",
  description:
    "Register an MCP or HTTP tool server in the workspace, or change an existing server's enabled state. The credential the server needs is named by connectionId and is never passed here (§6.7).",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,

  absorbs: ["register_mcp_server", "set_mcp_enabled"],
  renames: [
    {
      from: "mcpServerId",
      source: "set_mcp_enabled",
      to: "serverId",
      why: "Appendix A's `tools.tool_servers` also holds `http`, `harness` and `oxagen` servers, so an id named for MCP no longer describes the row it addresses. Carried by import (`agentMcpSetEnabled.input.shape.mcpServerId`) and made optional — its presence is what turns a registration into an update",
    },
  ],
  drops: [
    {
      field: "authConfig",
      from: "register_mcp_server",
      why: "secret material: pillar 12 (§6) holds that the agent has no credentials, and §6.7 step 5 brokers a per-call credential from tools.connections — the credential is set by set_connection and named here only by connectionId",
    },
    {
      field: "snapshotCount",
      from: "set_mcp_enabled",
      why: "tool-descriptor snapshots become immutable tools.tool_versions rows (Appendix A); their count is import_tools' answer, not a side fact of enabling a server",
    },
  ],

  // Neither source declares `agent` metadata, so none is invented here. Both
  // are api/mcp-surface administration; whether the in-app agent may register a
  // tool server for itself is a governance question Appendix E's approval rules
  // (`set_approval_rules`) settle at cutover, not a default this file should
  // quietly grant.
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow" },
  },
  // Writes tools.tool_servers and, on registration, runs a health check that
  // stamps the row. Both sources mutate.
  mutates: true,

  input: z.object({
    /**
     * Omitted registers a new server; present updates the named one. This is
     * the seam where `set_mcp_enabled` is absorbed — it only ever addressed an
     * existing row, so its id is carried by import and made optional.
     */
    serverId: agentMcpSetEnabled.input.shape.mcpServerId.optional(),

    // Carried by reference so the 1–120 bound stays attached; `unique per
    // workspace` (Appendix A) is enforced by the handler, not the schema.
    name: agentMcpRegister.input.shape.name,

    /**
     * New in v2. Appendix A separates what a server *is* from how it is
     * reached. `harness` (a coding harness's own shell/edit/browser tools,
     * §6.6) and `oxagen` (first-party capabilities) are registered by the
     * platform rather than by an operator, but the enum is the column's, so
     * they are spelled here and refused by the handler.
     */
    kind: z.enum(["mcp", "http", "harness", "oxagen"]),

    /**
     * Carried by import and widened with Appendix A's other two transports.
     * `openapi` is what makes an HTTP server describable at all, and `builtin`
     * is the harness/oxagen case. The two MCP members keep their v1 hyphenated
     * spelling on purpose: rewriting them to the column's underscored form
     * would silently invalidate every registration already in the database.
     */
    transportType: z.union([
      agentMcpRegister.input.shape.transportType,
      z.enum(["openapi", "builtin"]),
    ]),

    endpointUrl: agentMcpRegister.input.shape.endpointUrl,

    // Kept because it is a declaration of what the server *needs*, not a
    // secret. The value it names lives in tools.connections.
    authStrategy: agentMcpRegister.input.shape.authStrategy,

    /**
     * Appendix A `tools.tool_servers.connection_id`, "null for servers that
     * need no credential". Required to be absent when authStrategy is "none";
     * the pairing is a handler check rather than a refinement so `.shape` stays
     * reachable for the MCP parameter builder.
     */
    connectionId: z.string().min(1).nullable().default(null),

    /**
     * §6.12 needs to know whether a call leaves the tenant before it can decide
     * on it, and no v1 field carried that. New, from Appendix A's
     * `egress_class`.
     */
    egressClass: z.enum(["local", "org_tenant", "third_party"]),

    // Carried from set_mcp_enabled. Defaulting to enabled matches v1 register,
    // which had no disabled state at all.
    enabled: agentMcpSetEnabled.input.shape.enabled.default(true),
  }),

  output: z.object({
    serverId: agentMcpSetEnabled.output.shape.mcpServerId,
    enabled: agentMcpSetEnabled.output.shape.enabled,

    /**
     * Appendix A's `status` has three values and `enabled` has two: a server
     * that is `killed` reports `enabled: false` but cannot be re-enabled by
     * this tool. Both are surfaced so a caller can tell "I turned it off" from
     * "a kill switch turned it off".
     */
    status: z.enum(["active", "disabled", "killed"]),

    healthStatus: agentMcpRegister.output.shape.healthStatus,

    /**
     * Carried from register: the names the health check saw. It is a preview,
     * not the import — nothing is versioned into tools.tool_versions until
     * `import_tools` runs, so this list has no schemas and no digests.
     */
    discoveredTools: agentMcpRegister.output.shape.discoveredTools,
  }),
});

export type RegisterToolServerInput = z.output<typeof registerToolServer.input>;
export type RegisterToolServerOutput = z.output<
  typeof registerToolServer.output
>;
