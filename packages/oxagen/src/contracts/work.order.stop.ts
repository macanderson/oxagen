/**
 * stop_work_order: a person asks the runtime to stop the run a send started.
 * Oxagen queues a `cancel` to the run, carried by its host, and records the
 * request. The send reads stopping until the runtime confirms, and stopped
 * once it does. A stop that lands before the run is linked reaches the run
 * when it links. Commits and the pull request stay where they are. A person
 * decides it, signed in to Oxagen: an API key or an agent run is refused, so
 * an agent cannot decide its own work. The action names the item version the
 * person read, and the store refuses it when the item changed since (ADR-244,
 * ADR-251).
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { workItemIdSchema, workItemVersionSchema, workOrderAfterSchema, workOrderIdSchema, workReasonSchema, workWriteOutputShape } from "./work.order.shared";

export const workOrderStop = registerCapability({
  name: "stop_work_order",
  domain: "work",
  description:
    "Ask the runtime to stop the run a send started. The send reads stopped once the runtime confirms.",
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
    })
    .strict(),
  output: z
    .object({
      ...workWriteOutputShape,
      order: workOrderAfterSchema,
      /** The `cancel` command queued to the run (`tcm_…`), or null when no run is linked yet. */
      command_id: z.string().nullable(),
    })
    .strict(),
});

export type WorkOrderStopInput = z.input<typeof workOrderStop.input>;
export type WorkOrderStopOutput = z.output<typeof workOrderStop.output>;
