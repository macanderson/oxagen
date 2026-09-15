// list_approvals output to the Fleet approvals panel (ARCHITECTURE.md §3.4).
// Typed from the contract's `_output`; the agent key is the chain's first hop
// the store has, and it is null until the gateway records it.
import type { agentApprovalList } from "@oxagen/oxagen/contracts/agent.approval.list";
import type { z } from "zod";
import type { ApprovalItem } from "@/data/contracts/approvals";
import type { ContractOutput } from "@/server/kernel";

export function toApprovalItems(
  out: ContractOutput<typeof agentApprovalList>,
): z.input<typeof ApprovalItem>[] {
  return out.items.map((item) => ({
    id: item.id,
    runId: item.runId,
    tool: item.tool,
    agentKey: item.chain.agentKey,
    requester: item.requester,
    createdAt: item.createdAt,
    expiresAt: item.expiresAt,
  }));
}
