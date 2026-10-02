/**
 * return_work_order: a person returns a send's result to the agent with a
 * reason. The send ends, and by default the item goes out again to the same
 * agent as a new send whose first prompt carries the reason. When the agent
 * cannot take it now, the return stands and the item waits in ready. Phase 1
 * returns work only after the run ended or the pull request merged or closed.
 * A person decides it, signed in to Oxagen: an API key or an agent run is
 * refused, so an agent cannot decide its own work. The action names the item
 * version the person read, and the store refuses it when the item changed
 * since (ADR-244, ADR-250).
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { workItemIdSchema, workItemVersionSchema, workOrderAfterSchema, workOrderIdSchema, workReasonSchema, workWriteOutputShape } from "./work.order.shared";

export const workOrderReturn = registerCapability({
  name: "return_work_order",
  domain: "work",
  description:
    "Return a send's result to the agent with a reason. By default the item goes out again to the same agent as a new send.",
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
    workspace: { Owner: "allow", Member: "allow" },
  },
  audit: { targetKind: "work_order", targetIdField: "work_order_id" },
  input: z
    .object({
      item_id: workItemIdSchema,
      /** The item version the person read. */
      version: workItemVersionSchema,
      work_order_id: workOrderIdSchema,
      reason: workReasonSchema,
      /** Send the item again to the same agent. False leaves it ready. */
      resend: z.boolean().default(true),
    })
    .strict(),
  output: z
    .object({
      ...workWriteOutputShape,
      order: workOrderAfterSchema,
      /** The new send, or null when none went out. */
      resent: workOrderAfterSchema.nullable(),
      /** Why no new send went out, when `resend` asked for one. */
      resend_refused: z.string().nullable(),
    })
    .strict(),
});

export type WorkOrderReturnInput = z.input<typeof workOrderReturn.input>;
export type WorkOrderReturnOutput = z.output<typeof workOrderReturn.output>;
