/**
 * cancel_work_order: a person withdraws a send no runtime has claimed. The
 * send ends at once, its `work_order` command is cancelled, and a claim the
 * host makes after this is refused, so no run starts. A send a runtime already
 * claimed is stopped with stop_work_order instead. A person decides it, signed
 * in to Oxagen: an API key or an agent run is refused, so an agent cannot
 * decide its own work. The action names the item version the person read, and
 * the store refuses it when the item changed since (ADR-244, ADR-251).
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { workItemIdSchema, workItemVersionSchema, workOrderAfterSchema, workOrderIdSchema, workReasonSchema, workWriteOutputShape } from "./work.order.shared";

export const workOrderCancel = registerCapability({
  name: "cancel_work_order",
  domain: "work",
  description:
    "Withdraw a send that no runtime has claimed. The send ends at once and no run starts.",
  mode: "sync",
  surfaces: ["api"],
  layers: ["schema", "api", "unit", "docs", "app"],
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
    })
    .strict(),
  output: z
    .object({
      ...workWriteOutputShape,
      order: workOrderAfterSchema,
    })
    .strict(),
});

export type WorkOrderCancelInput = z.input<typeof workOrderCancel.input>;
export type WorkOrderCancelOutput = z.output<typeof workOrderCancel.output>;
