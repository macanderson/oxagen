import type { CapabilityContext } from "../types";
import { listConsents } from "../runtime/consent";
import type {
  AgentMcpConsentListInput,
  AgentMcpConsentListOutput,
} from "@oxagen/oxagen/contracts/agent.mcp.consent.list";

export type { AgentMcpConsentListInput, AgentMcpConsentListOutput };

export async function agentMcpConsentListHandler(
  input: AgentMcpConsentListInput,
  ctx: CapabilityContext,
): Promise<AgentMcpConsentListOutput> {
  const consents = await listConsents({
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    userId: input.mineOnly ? ctx.userId : null,
  });
  return { consents };
}
