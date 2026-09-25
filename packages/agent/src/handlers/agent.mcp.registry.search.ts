import type { CapabilityContext } from "../types";
import { searchMcpRegistry } from "../runtime/mcp-registry";
import type {
  AgentMcpRegistrySearchInput,
  AgentMcpRegistrySearchOutput,
} from "@oxagen/oxagen/contracts/agent.mcp.registry.search";

export type { AgentMcpRegistrySearchInput, AgentMcpRegistrySearchOutput };

/**
 * Searches the official MCP Registry and the verified first-party list
 * (`runtime/mcp-registry.ts`). It reads public metadata and writes nothing, so
 * any workspace member may search; adding a result is `register_mcp_server`
 * or `start_mcp_authorization`, which check the role.
 */
export async function agentMcpRegistrySearchHandler(
  input: AgentMcpRegistrySearchInput,
  _ctx: CapabilityContext,
): Promise<AgentMcpRegistrySearchOutput> {
  return searchMcpRegistry({
    query: input.query,
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    limit: input.limit,
  });
}
