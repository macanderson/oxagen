// list_approvals — the workspace's pending tool-call approvals, soonest expiry
// first, cursor-paged. The read behind the Fleet approvals panel and the Run
// approvals strip (apps/app/ARCHITECTURE.md §1.2, §3.3).
//
// A console read is outside the metering surface (ADR-052 exclusion 2,
// INV-28), so the contract declares `noBillingGate: true`: a page load or an
// SSE poll of this list meters nothing and locks nobody out. `mutates: false` is what
// lets the app's `kernelRead` accept it (INV-03).
//
// Every item field is either recorded on the approval row, joined from a row
// the approval names, or null. The store records no run and no chain on an
// approval today: `agent.approval_requests` carries `message_id`,
// `execution_step_id` and `tool_call_id` (packages/database/src/schema/
// agent.ts:130-151) and none of them names an `agent_runs` or
// `tacho_sessions` row, and no column carries the agent key or the rule that
// parked the call (the gateway of MC spec §7.5, which writes the four-hop
// chain, does not exist). Those fields are nullable and null.
import { z } from "zod";
import { registerCapability } from "../registry";

const instant = z.string().datetime({ offset: true });

export const approvalListItem = z
  .object({
    /** The approval's public id (`apr_…`). */
    id: z.string().regex(/^apr_[0-9a-z]+$/),
    /**
     * The public id of the run the call belongs to. Null: the store records
     * no run on an approval (see the header comment).
     */
    runId: z.string().nullable(),
    /** The capability the parked call asked for (`approval_requests.capability_name`). */
    tool: z.string().min(1),
    /**
     * The public id (`usr_…`) of the person whose conversation turn parked the
     * call: `approval_requests.message_id` → `chat.messages` →
     * `chat.conversations.user_id` → `auth.users`. Null when the message or
     * its conversation is no longer readable.
     */
    requester: z.string().nullable(),
    createdAt: instant,
    expiresAt: instant,
    /** The hops of the four-hop chain the row does not carry itself (MC spec §7.5). */
    chain: z
      .object({
        /** The key of the agent that raised the call. Not recorded today. */
        agentKey: z.string().nullable(),
        /** The grant, mandate or standing rule that parked the call. Not recorded today. */
        rule: z.string().nullable(),
      })
      .strict(),
  })
  .strict();

export const agentApprovalList = registerCapability({
  name: "list_approvals",
  domain: "agent",
  description:
    "List the workspace's pending tool-call approvals, soonest expiry first, cursor-paged, optionally narrowed to one run",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  agent: { requiresApproval: false, riskLevel: "low", category: "approval" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Member: "allow" },
    workspace: {},
  },
  input: z
    .object({
      /** Only approvals recorded on this run (a run public id). */
      runId: z.string().min(1).max(64).optional(),
      limit: z.number().int().min(1).max(100).default(50),
      /** The `nextCursor` of the previous page. */
      cursor: z.string().max(256).optional(),
    })
    .strict(),
  output: z
    .object({
      items: z.array(approvalListItem).max(100),
      nextCursor: z.string().nullable(),
    })
    .strict(),
});

export type AgentApprovalListInput = z.output<typeof agentApprovalList.input>;
export type AgentApprovalListOutput = z.output<typeof agentApprovalList.output>;
