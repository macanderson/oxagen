import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * An approval request id in either of its two forms (#2906):
 *
 * - the public id `apr_…` that list reads and the app show, or
 * - the row uuid that the runtime keys its waiters on and that the deprecated
 *   app still sends from stream events.
 *
 * Handlers match `public_id` for the first form and `id` for the second, always
 * inside tenant scope. Anything else is refused at the edge instead of reaching
 * Postgres as an invalid uuid literal.
 */
const PUBLIC_ID = /^apr_[0-9a-z]+$/i;
const ROW_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The schema's accept-set is the union of the two patterns `isApprovalPublicId`
// chooses between, so a value the contract admits always lands in one branch.
export const approvalIdSchema = z
  .string()
  .refine(
    (value) => PUBLIC_ID.test(value) || ROW_UUID.test(value),
    "approvalId must be a public id (apr_…) or a uuid",
  );

export function isApprovalPublicId(value: string): boolean {
  return PUBLIC_ID.test(value);
}

/**
 * What became of the approved call itself (ADR-118), read back from the
 * approval row once the decision has been delivered. `status` is the row's
 * `resume_status`: `succeeded` or `dispatched` when the call ran, `failed` or
 * `indeterminate` when it did not or its outcome is unknown, `queued` when
 * delivery is left to the periodic worker, `denied` or `expired` when it will
 * never run. `runId` is the fresh run the call was recorded as; `reason` is the
 * refusal or failure code.
 */
const approvalExecutionSchema = z.object({
  status: z.string(),
  runId: z.string().nullable(),
  reason: z.string().nullable(),
});

// `resolve_approval` is the rev1 governed action (apps/app/ARCHITECTURE.md
// §1.5): the human decision on a tool call is what ADR-052 bills, so the
// contract carries no `noBillingGate`. A decision that matches no row leaves
// the handler as `HandlerError { code: "conflict", reason: "approval_expired" }`
// and never reaches the recorder, which is why the output enum holds only the
// two decisions a caller can make (§3.9 item 15).
export const agentApprovalResolve = registerCapability({
  name: "resolve_approval",
  domain: "agent",
  description:
    "Approve or deny a pending tool-call approval request; an approved call the in-app assistant parked runs at once, and the answer says what became of it",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs", "app"],
  scoped: true,
  // Writes the resolution onto the approval row and, on a mandate row that
  // is denied, releases the reservation.
  mutates: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "approval" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    approvalId: approvalIdSchema,
    decision: z.enum(["approved", "denied"]),
    note: z.string().optional(),
  }),
  output: z.object({
    // Echoes the id in the form the caller sent (public id or uuid).
    approvalId: z.string(),
    resolution: z.enum(["approved", "denied"]),
    /**
     * The mandate settlement (ADR-059 decision 4): on a row the mandate gate
     * parked, the mandate's public id, the reservation by measure, and
     * whether the reservation stays `held` (approved: the agent's retry
     * settles it on receipt) or was `released` (denied). Null on a row the
     * chat approval gate wrote.
     */
    mandate: z
      .object({
        mandateId: z.string(),
        reserved: z.array(
          z.object({
            measure: z.string(),
            value: z.string(),
            unitOrCurrency: z.string(),
          }),
        ),
        outcome: z.enum(["held", "released"]),
      })
      .nullable(),
    /**
     * The parked call's execution (ADR-118): on a row the in-app assistant
     * parked, what the call did once this decision was delivered. Null on a
     * row with no stored call (a mandate row, a legacy row, a budget pause).
     * Optional because the field was added after callers began building this
     * output by hand.
     */
    execution: approvalExecutionSchema.nullable().optional(),
  }),
});

export type AgentApprovalResolveInput = z.output<
  typeof agentApprovalResolve.input
>;
export type AgentApprovalResolveOutput = z.output<
  typeof agentApprovalResolve.output
>;
