// list_resolved_approvals: the workspace's resolved approvals, most recently
// resolved first, cursor-paged, optionally narrowed to one run or a resolved
// time range. The read `list_approvals` cannot serve: that capability filters
// `resolution IS NULL`, so a row an auto-approval rule resolved the instant it
// was written never appears there (#3153).
//
// This is the read side of `autoApprovePath` (`packages/rules/src/auto-approval-path.ts`):
// every call a rule released without a person writes a fully resolved row,
// `resolution: "approved"`, `resolvedByPolicy`, `autoRuleId`, `ruleIds`,
// `inputDigest`, `resolvedAt`, and until this capability existed, nothing
// could read that row back. A row a person resolved (`resolvedByUserId` set)
// appears here too, so the same query answers both "what did the rule let
// through" and "what did a person approve or deny".
//
// A console read is outside the metering surface (ADR-052 exclusion 2,
// INV-28), so the contract declares `noBillingGate: true`.
import { z } from "zod";
import {
  autoEligibilitySchema,
  resolvedBySchema,
} from "../approval-rules/schemas";
import { registerCapability } from "../registry";

const instant = z.string().datetime({ offset: true });

export const resolvedApprovalListItem = z
  .object({
    /** The approval's public id (`apr_…`), the id `get_auto_eligibility` needs. */
    id: z.string().regex(/^apr_[0-9a-z]+$/),
    /** The public id of the run the call was parked in (`arun_…` or `tse_…`); null when none was in scope. */
    runId: z.string().nullable(),
    /** The capability the parked call asked for (`approval_requests.capability_name`). */
    tool: z.string().min(1),
    /** The public id (`usr_…`) of the person whose conversation turn parked the call; null when not readable. */
    requester: z.string().nullable(),
    createdAt: instant,
    expiresAt: instant,
    resolvedAt: instant,
    execution: z
      .object({
        status: z.string(),
        runId: z.string().nullable(),
        reason: z.string().nullable(),
      })
      .optional(),
    resolution: z.enum(["approved", "denied", "expired"]),
    /**
     * Who resolved it: `user:<usr_…>` or `policy:<rule id>` (mutually
     * exclusive on the row, ADR-070). Null only for the unreachable case of a
     * resolved row with neither set.
     */
    resolvedBy: resolvedBySchema.nullable(),
    /**
     * The auto-approval rule that resolved this call without a person, echoed
     * on its own so a caller does not have to decode `resolvedBy` to show it
     * (`approval_requests.auto_rule_id`). Null when a person resolved the row
     * or no rule covered it.
     */
    autoRuleId: z.string().nullable(),
    /** The evaluation recorded when the call was parked (ADR-070); null when no rule covered it. */
    autoEligibility: autoEligibilitySchema.nullable(),
    /** The public id (`mnd_…`) of the mandate the parked call drew on; null on a row the chat approval gate wrote. */
    mandateId: z.string().nullable(),
    /** The hops of the four-hop chain (MC spec §7.5). */
    chain: z
      .object({
        /** The key of the agent that raised the call. Not recorded today. */
        agentKey: z.string().nullable(),
        /** The first of `approval_requests.rule_ids`; null on a row the chat approval gate wrote. */
        rule: z.string().nullable(),
      })
      .strict(),
  })
  .strict();

export const agentApprovalListResolved = registerCapability({
  name: "list_resolved_approvals",
  domain: "agent",
  description:
    "List the workspace's resolved approvals, most recently resolved first, cursor-paged, optionally narrowed to one run or a resolved-at time range, including the rule that auto-approved a call no person looked at",
  mode: "sync",
  surfaces: ["api", "mcp", "cli"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  agent: { requiresApproval: false, riskLevel: "low", category: "approval" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z
    .object({
      /** Only approvals recorded on this run (a run public id). */
      runId: z.string().min(1).max(64).optional(),
      /** Only rows resolved at or after this instant. */
      since: instant.optional(),
      /** Only rows resolved at or before this instant. */
      until: instant.optional(),
      limit: z.number().int().min(1).max(100).default(50),
      /** The `nextCursor` of the previous page. */
      cursor: z.string().max(256).optional(),
    })
    .strict(),
  output: z
    .object({
      items: z.array(resolvedApprovalListItem).max(100),
      nextCursor: z.string().nullable(),
    })
    .strict(),
});

export type AgentApprovalListResolvedInput = z.output<
  typeof agentApprovalListResolved.input
>;
export type AgentApprovalListResolvedOutput = z.output<
  typeof agentApprovalListResolved.output
>;
