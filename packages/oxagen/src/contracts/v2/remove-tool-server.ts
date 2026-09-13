import { z } from "zod";
import { defineTool } from "./_define";
import { agentMcpDelete } from "../agent.mcp.delete";

/**
 * Appendix E: `remove_tool_server`. Absorbs `delete_mcp_server`, and nothing
 * else — Appendix E leaves the `Does` column empty, which is its way of saying
 * the v1 behaviour is already right.
 *
 * So this is the one shape in the batch that is a clean 1:1 carry, and
 * `drops: []` is a claim a reviewer can check: every field `delete_mcp_server`
 * had is here.
 *
 * The only change is the name of the id. v1 called it `mcpServerId` because an
 * MCP server was the only kind that existed; Appendix A's `tools.tool_servers`
 * also holds `http`, `harness` and `oxagen` servers, so the v2 field is
 * `serverId`. The *schema* is carried by import rather than retyped, which is
 * what keeps this a rename and not a rewrite.
 *
 * What does not change is the retention rule in v1's description, and it is
 * load-bearing: removal is a soft delete because `tools.tool_versions` rows are
 * what a run's frames cite when proving which schema the model was shown
 * (§6.6). Purging them would break replay of runs that already happened, so the
 * description is carried almost verbatim.
 */
export const removeToolServer = defineTool({
  name: "remove_tool_server",
  domain: "tools",
  description:
    "Soft-delete a registered tool server. Its tools stop appearing in any belt immediately, but its tool-version rows are retained >= 365 days so past runs stay replayable. The change is audited.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,

  absorbs: ["delete_mcp_server"],
  renames: [
    {
      from: "mcpServerId",
      source: "delete_mcp_server",
      to: "serverId",
      why: "Appendix A's `tools.tool_servers` holds `mcp`, `http`, `harness` and `oxagen` servers, so the id is no longer MCP-specific. Carried by import (`agentMcpDelete.input.shape.mcpServerId`), which is what keeps this a rename and not a rewrite — the soft-delete retention rule it addresses is unchanged",
    },
  ],
  // A clean 1:1 carry. `mcpServerId` is renamed to `serverId` but carried by
  // import, so it is not a drop.
  drops: [],

  // `delete_mcp_server` declares no `agent` metadata and none is invented:
  // removing a server is how a workspace loses capability, and the sibling
  // `set_kill_switch` (§6.13) is the tool built for an agent-reachable stop.
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow" },
  },
  // Writes tools.tool_servers (status + deleted_at) and drops the server's
  // tools out of every cached belt.
  mutates: true,

  input: z.object({
    // Carried by import; renamed because "mcp" is no longer the only kind.
    serverId: agentMcpDelete.input.shape.mcpServerId,
  }),

  output: z.object({
    serverId: agentMcpDelete.output.shape.mcpServerId,
    deleted: agentMcpDelete.output.shape.deleted,
  }),
});

export type RemoveToolServerInput = z.output<typeof removeToolServer.input>;
export type RemoveToolServerOutput = z.output<typeof removeToolServer.output>;
