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
// the approval names, or null. `agent.approval_requests.run_public_id` records
// the run a call was parked in (#3286), so `runId` both filters and comes back
// on each item. It is a public id because both kinds of run this product
// tracks have to be representable — `agent_runs` (`arun_…`) and
// `tacho.sessions` (`tse_…`) — and no one table holds both. A row parked
// outside any run records none, and a null is "not recorded", never "some
// other run". The store records no agent key. The mandate hop and the rule
// that parked the call are recorded on rows the mandate gate writes (ADR-059)
// and null on the chat gate's rows.
import { z } from "zod";
import { autoEligibilitySchema } from "../approval-rules/schemas";
import { registerCapability } from "../registry";

const instant = z.string().datetime({ offset: true });

export const approvalListItem = z
  .object({
    /** The approval's public id (`apr_…`). */
    id: z.string().regex(/^apr_[0-9a-z]+$/),
    /**
     * The public id of the run the call was parked in (`arun_…` or `tse_…`);
     * null when no run was in scope, or when the writer records none yet (the
     * mandate gate and the MCP consent path do not thread a run through).
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
    /**
     * The public id (`mnd_…`) of the mandate the parked call drew on
     * (`approval_requests.mandate_id`, ADR-059); null on a row the chat
     * approval gate wrote.
     */
    mandateId: z.string().nullable(),
    /**
     * What the workspace's auto-approval clause said about this call when it
     * was parked: the rule that was read, whether it qualified, and every
     * reason it did not (ADR-070). Null when no rule covered the call.
     *
     * A row a mandate parked can carry `ok: true` and still be here: a
     * mandate's own approval rule outranks any workspace rule (§6.9 part 3),
     * so the eligibility line says the rule would have released the call and
     * the mandate asked for a person anyway.
     */
    autoEligibility: autoEligibilitySchema.nullable(),
    /** The hops of the four-hop chain (MC spec §7.5). */
    chain: z
      .object({
        /** The key of the agent that raised the call. Not recorded today. */
        agentKey: z.string().nullable(),
        /**
         * The rule that parked the call: the first of `approval_requests.rule_ids`
         * (`mandate:<id>:human_above:<measure>` or `…:always_human_for:<tag>`);
         * null on a row the chat approval gate wrote.
         */
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
  surfaces: ["api", "mcp", "agent"],
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
