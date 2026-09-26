/**
 * agent-options-data.ts — server-only loader for the chat composer's agent
 * selector.
 *
 * The selector listed agent definitions (`list_agent_defs`), which ADR-192
 * removed: an agent is now one operator on one runtime with one harness, and
 * there is no definition for a conversation to bind to. The loader answers an
 * empty list, so the deprecated chat page renders with no agent to pick.
 */
import type { CapabilityContext } from "@oxagen/oxagen";
// Type-only import from the pure agent-picker types module — the single source
// of truth for the option shape. Erased at build time, so no client code is
// pulled in.
import type { AgentOption } from "@/components/chat/agent-picker/agent-picker-types";

export type { AgentOption };

/** No agent definition is selectable since ADR-192. */
export async function loadAgentOptions(
  _orgId: string,
  _workspaceId: string,
  _ctx: CapabilityContext,
): Promise<AgentOption[]> {
  return [];
}
