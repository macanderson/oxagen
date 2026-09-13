// The approvals queue: a panel on Fleet and a strip on Run (spec §7.5, §14).
import { z } from "zod";
import {
  AgentKey,
  Digest,
  EgressClass,
  EnforcementTier,
  Instant,
  Money,
  PublicId,
  Risk,
  SideEffect,
  Slug,
  ToolVersionRef,
} from "./common";

/** Pending until a person (or an auto-approval rule) resolves it; `control.approvals.decision`. */
export const ApprovalStatus = z.enum([
  "pending",
  "approved",
  "denied",
  "expired",
]);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

/** What a rule contributed to the decision. */
export const RuleVerdict = z.enum(["allow", "approve", "constrain", "deny"]);
export type RuleVerdict = z.infer<typeof RuleVerdict>;

/** The rule that raised the call to a human: the fourth hop of the chain. */
export const ApprovalTrigger = z.object({
  kind: z.enum(["mandate", "role_grant", "taint", "policy"]),
  /** The mandate, grant or rule id the trigger names. */
  ref: z.string(),
  detail: z.string(),
});
export type ApprovalTrigger = z.infer<typeof ApprovalTrigger>;

export const ApprovalItem = z.object({
  id: PublicId,
  runId: PublicId,
  workspaceSlug: Slug,
  status: ApprovalStatus,
  /** The four-hop chain: who asked, which agent, which action, which rule. */
  chain: z.object({
    operatorId: PublicId,
    agentKey: AgentKey,
    action: ToolVersionRef,
    trigger: ApprovalTrigger,
  }),
  risk: Risk,
  sideEffect: SideEffect,
  egress: EgressClass,
  /** The measured amount, when the tool declares one. */
  amount: Money.nullable(),
  counterparty: z.string(),
  mandateId: PublicId.nullable(),
  policyVersionId: PublicId,
  inputDigest: Digest,
  tainted: z.boolean(),
  tier: EnforcementTier,
  requestedAt: Instant,
  expiresAt: Instant,
  approvers: z.object({
    roles: z.array(z.string()),
    eligiblePersonIds: z.array(PublicId),
    /** People excluded from resolving this one, with the rule that excludes them. */
    excluded: z.array(z.object({ personId: PublicId, rule: z.string() })),
  }),
  rules: z.array(
    z.object({ id: z.string(), verdict: RuleVerdict, text: z.string() }),
  ),
  taintSources: z.array(
    z.object({
      frameSeq: z.number().int().nonnegative(),
      tool: ToolVersionRef,
      path: z.string(),
      note: z.string(),
    }),
  ),
});
export type ApprovalItem = z.infer<typeof ApprovalItem>;
