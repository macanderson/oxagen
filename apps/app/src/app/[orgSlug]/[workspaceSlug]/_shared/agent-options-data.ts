/**
 * agent-options-data.ts — server-only loader for the chat composer's agent
 * selector.
 *
 * Lists the workspace's agents (via agent.definition.list) so the new-session
 * flow can offer an agent picker. Each option carries its `agentType` and a
 * derived `isCode` flag (agentType === "code", see isCodeAgentType) — the
 * signal the composer uses to reveal the repo/code tooling + UI for a code
 * agent and hide it for a plain chat agent.
 *
 * Follows the direct-handler-call pattern used by code-mode-data.ts (not
 * invoke() — apps/app doesn't bootstrap the IAM kernel invoke() expects; see
 * CLAUDE.md "apps/app does not bootstrap IAM"). Never throws — a failed read
 * degrades to an empty list so the chat page's Promise.all never crashes
 * because the agent list couldn't load.
 */
import { runInTenantScope } from "@oxagen/tenancy";
import { agentDefinitionListHandler } from "@oxagen/agent/handlers/agent.definition.list";
import { logger } from "@oxagen/handlers/logger";
import { isCodeAgentType } from "@oxagen/oxagen";
import type { CapabilityContext } from "@oxagen/oxagen";
// Type-only import from the (client) selector component — the single source of
// truth for the option shape, mirroring how code-mode-data imports RepoOption
// from repo-selector. Erased at build time, so no client code is pulled in.
import type { AgentOption } from "@/components/chat/agent-selector";

export type { AgentOption };

/**
 * Load the workspace's selectable agents. Archived agents are excluded (they're
 * not runnable); drafts are kept so a just-created agent is immediately
 * pickable. Degrades to an empty list on any failure.
 */
export async function loadAgentOptions(
  orgId: string,
  workspaceId: string,
  ctx: CapabilityContext,
): Promise<AgentOption[]> {
  try {
    return await runInTenantScope({ orgId, workspaceId }, async () => {
      const { agents } = await agentDefinitionListHandler({}, ctx);
      return agents
        .filter((a) => a.status !== "archived")
        .map(
          (a): AgentOption => ({
            agentId: a.agentId,
            slug: a.slug,
            name: a.name,
            description: a.description,
            agentType: a.agentType,
            isCode: isCodeAgentType(a.agentType),
          }),
        );
    });
  } catch (err) {
    logger.warn({ err, orgId, workspaceId }, "agent-options-data: loadAgentOptions failed — degraded");
    return [];
  }
}
