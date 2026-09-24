// list_approvals output to the shell's approvals drawer (ARCHITECTURE.md §3.4).
// Typed from the contract's `_output`; the agent key is the chain's first hop
// the store has, and it is null until the gateway records it.
//
// Both hops the contract records travel: `chain.agentKey` and `chain.rule`.
// The card draws four hops (who asked, which agent, which action, which rule),
// and dropping the rule left the fourth hop blank on every card, including the
// rows a mandate parked, which are exactly the rows that record one. The
// recorded auto-approval evaluation travels for the same reason: it is what
// the card's eligibility line reads, and recomputing it would show what the
// rules say now rather than what judged this call (ADR-070).
import type { agentApprovalList } from "@oxagen/oxagen/contracts/agent.approval.list";
import type { agentApprovalListResolved } from "@oxagen/oxagen/contracts/agent.approval.list_resolved";
import type { z } from "zod";
import { toAutoEligibility } from "@/data/contracts/approvals";
import type {
  ApprovalItem,
  ResolvedApprovalItem,
} from "@/data/contracts/approvals";
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
    mandateId: item.mandateId,
    rule: item.chain.rule,
    autoEligibility: toAutoEligibility(item.autoEligibility),
    createdAt: item.createdAt,
    expiresAt: item.expiresAt,
  }));
}

// list_resolved_approvals output to the Run page's Approvals tab (#3153):
// what a decision rule released with no person, alongside what a person
// approved or denied, read back by the id the write path once threw away.
export function toResolvedApprovalItems(
  out: ContractOutput<typeof agentApprovalListResolved>,
): z.input<typeof ResolvedApprovalItem>[] {
  return out.items.map((item) => ({
    id: item.id,
    runId: item.runId,
    tool: item.tool,
    agentKey: item.chain.agentKey,
    requester: item.requester,
    rule: item.chain.rule,
    mandateId: item.mandateId,
    createdAt: item.createdAt,
    expiresAt: item.expiresAt,
    resolvedAt: item.resolvedAt,
    resolution: item.resolution,
    ...(item.execution ? { execution: item.execution } : {}),
    resolvedBy: item.resolvedBy,
    autoRuleRef: item.autoRuleId,
  }));
}
