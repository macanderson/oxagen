import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import type { CapabilityContext } from "../types";
import { startMcpAuthorization } from "../runtime/mcp-oauth-flow";
import type {
  AgentMcpAuthorizeStartInput,
  AgentMcpAuthorizeStartOutput,
} from "@oxagen/oxagen/contracts/agent.mcp.authorize.start";

export type { AgentMcpAuthorizeStartInput, AgentMcpAuthorizeStartOutput };

/**
 * Starts OAuth for a provider (`runtime/mcp-oauth-flow.ts`). A person
 * authorizes a connection, never an agent: the role check resolves the acting
 * user and requires the same roles `register_mcp_server` declares, asserted
 * here because `checkIAM` fast-paths non-enterprise orgs (#3258).
 */
export async function agentMcpAuthorizeStartHandler(
  input: AgentMcpAuthorizeStartInput,
  ctx: CapabilityContext,
): Promise<AgentMcpAuthorizeStartOutput> {
  const userId = await resolveActingUserId(ctx);
  await assertOrgRole(
    { ...ctx, userId },
    { org: ["Owner", "Admin"], workspace: ["Owner"] },
  );
  return startMcpAuthorization(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, userId },
    input,
  );
}
