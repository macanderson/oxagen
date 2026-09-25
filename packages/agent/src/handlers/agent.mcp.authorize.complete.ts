import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import type { CapabilityContext } from "../types";
import { completeMcpAuthorization } from "../runtime/mcp-oauth-flow";
import type {
  AgentMcpAuthorizeCompleteInput,
  AgentMcpAuthorizeCompleteOutput,
} from "@oxagen/oxagen/contracts/agent.mcp.authorize.complete";

export type { AgentMcpAuthorizeCompleteInput, AgentMcpAuthorizeCompleteOutput };

/**
 * Finishes OAuth for a provider. The saved flow state is bound to the
 * workspace that started it, so a code from one workspace's sign-in cannot
 * complete in another's.
 */
export async function agentMcpAuthorizeCompleteHandler(
  input: AgentMcpAuthorizeCompleteInput,
  ctx: CapabilityContext,
): Promise<AgentMcpAuthorizeCompleteOutput> {
  const userId = await resolveActingUserId(ctx);
  await assertOrgRole(
    { ...ctx, userId },
    { org: ["Owner", "Admin"], workspace: ["Owner"] },
  );
  return completeMcpAuthorization(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, userId },
    input,
  );
}
