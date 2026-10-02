/**
 * claim_work_order: an enrolled host claims a work order before it starts a
 * run for it (P1-04, ADR-251).
 *
 * The host received the order as a `work_order` command. The claim is the
 * handshake before anything starts: it binds the order to this host, and its
 * answer carries the first prompt the run starts with, the approved brief and
 * then the issue text fenced as data. A claim on a send that ended (withdrawn,
 * stopped, returned, or rejected) is refused, so the host must not start it.
 *
 * A host that claims again, after a lost answer, gets the same claim and the
 * same prompt back and records nothing new, so it never needs a second run to
 * find out. Another host's claim on the same order is refused: one claimant
 * per send.
 *
 * Machine to machine: the host's API key carries its org and workspace, and
 * the handler checks the key belongs to the enrollment the call names.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { hostEnrollmentIdSchema } from "../tacho/schemas";
import { workItemIdSchema, workOrderIdSchema } from "./work.order.shared";

export const workOrderClaim = registerCapability({
  name: "claim_work_order",
  domain: "work",
  description:
    "Claim a work order for the calling enrolled host before it starts a run, and read the first prompt the run starts with.",
  mode: "sync",
  surfaces: ["api"],
  layers: ["schema", "api", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  audit: { targetKind: "work_order", targetIdField: "work_order_id" },
  input: z
    .object({
      host_enrollment_id: hostEnrollmentIdSchema,
      work_order_id: workOrderIdSchema,
    })
    .strict(),
  output: z
    .object({
      /** True when this host had already claimed the order. Nothing new was recorded. */
      repeat: z.boolean(),
      work_order: z
        .object({
          id: workOrderIdSchema,
          key: z.string(),
          send: z.number().int().min(1),
          item_id: workItemIdSchema,
          /** The work item's number, such as `aintel/platform#612`. */
          item_number: z.string(),
          brief_revision: z.number().int().min(1),
          /** The repository the work changes, as owner/name. */
          repository: z.string(),
          /** The agent the order went to (`agt_…`), and its harness. */
          agent_id: z.string(),
          harness: z.string(),
        })
        .strict(),
      /** The first prompt of the run: the brief, then the issue text fenced as data. */
      prompt: z.string(),
    })
    .strict(),
});

export type WorkOrderClaimInput = z.input<typeof workOrderClaim.input>;
export type WorkOrderClaimOutput = z.output<typeof workOrderClaim.output>;
