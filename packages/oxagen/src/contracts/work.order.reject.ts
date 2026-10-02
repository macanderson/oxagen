/**
 * reject_work_order: an enrolled host refuses a work order it cannot start,
 * with the reason, such as a harness that is signed out (P1-04, ADR-251).
 *
 * The send ends as rejected, the agent is free again, and the work item goes
 * back to ready so a person can send it again or close it. A host can reject
 * an order it has not linked a run to. Once a run is linked, the run's own end
 * is the record.
 *
 * Machine to machine: the host's API key carries its org and workspace, and
 * the handler checks the key belongs to the enrollment the call names.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { hostEnrollmentIdSchema } from "../tacho/schemas";
import { workOrderIdSchema } from "./work.order.shared";

export const workOrderReject = registerCapability({
  name: "reject_work_order",
  domain: "work",
  description:
    "Refuse a work order the calling enrolled host cannot start, with the reason. The send ends and the work item can be sent again.",
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
      reason: z.string().trim().min(1).max(512),
    })
    .strict(),
  output: z
    .object({
      /** True when the order was already rejected. Nothing new was recorded. */
      repeat: z.boolean(),
    })
    .strict(),
});

export type WorkOrderRejectInput = z.input<typeof workOrderReject.input>;
export type WorkOrderRejectOutput = z.output<typeof workOrderReject.output>;
