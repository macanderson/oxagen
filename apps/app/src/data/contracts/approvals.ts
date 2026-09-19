// A pending tool-call approval as the Fleet approvals panel reads it
// (ARCHITECTURE.md §1.2), from `list_approvals`. The store records no run and
// no agent on an approval today, so both are nullable and null until it does.
import { z } from "zod";
import { PublicId } from "./common";

export const ApprovalItem = z.object({
  id: PublicId,
  runId: PublicId.nullable(),
  /** The capability the parked call asked for. */
  tool: z.string().min(1),
  agentKey: z.string().min(1).nullable(),
  /** The person whose turn parked the call. */
  requester: PublicId.nullable(),
  /**
   * The mandate the parked call drew on (`mnd_…`); null on a row the chat
   * approval gate wrote, which draws on no mandate.
   */
  mandateId: PublicId.nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
});
export type ApprovalItem = z.infer<typeof ApprovalItem>;

// A resolved approval as the Run page's Approvals tab reads it, from
// `list_resolved_approvals` (#3153). Carries what `ApprovalItem` carries plus
// the resolution: when it happened, who or what made it, and, when a
// decision rule released the call with no person, the rule that did.
export const ResolvedApprovalItem = z.object({
  id: PublicId,
  runId: PublicId.nullable(),
  tool: z.string().min(1),
  requester: PublicId.nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
  resolvedAt: z.iso.datetime({ offset: true }),
  resolution: z.enum(["approved", "denied", "expired"]),
  /** `user:<usr_…>` or `policy:<rule id>`; null only for the unreachable case of neither being set. */
  resolvedBy: z.string().min(1).nullable(),
  /** The auto-approval rule that resolved this call with no person; null when a person resolved it or no rule covered it. */
  autoRuleId: z.string().min(1).nullable(),
});
export type ResolvedApprovalItem = z.infer<typeof ResolvedApprovalItem>;
