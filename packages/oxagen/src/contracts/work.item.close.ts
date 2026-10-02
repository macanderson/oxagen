/**
 * close_work_item: a person closes a work item without finishing it, as
 * cancelled, declined, or a duplicate, with a reason. A send still out must be
 * withdrawn or stopped first. Oxagen writes nothing back to the source: a
 * GitHub issue stays open. A person decides it, signed in to Oxagen: an API
 * key or an agent run is refused, so an agent cannot decide its own work. The
 * action names the item version the person read, and the store refuses it when
 * the item changed since (ADR-244, ADR-250).
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { WORK_ACTION_CLOSE_RESOLUTIONS, workItemIdSchema, workItemVersionSchema, workReasonSchema, workWriteOutputShape } from "./work.order.shared";

export const workItemClose = registerCapability({
  name: "close_work_item",
  domain: "work",
  description:
    "Close a work item without finishing it, as cancelled, declined, or a duplicate. The source issue stays open.",
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
  audit: { targetKind: "work_item", targetIdField: "item_id" },
  input: z
    .object({
      item_id: workItemIdSchema,
      /** The item version the person read. */
      version: workItemVersionSchema,
      resolution: z.enum(WORK_ACTION_CLOSE_RESOLUTIONS),
      reason: workReasonSchema,
    })
    .strict(),
  output: z
    .object({
      ...workWriteOutputShape,
    })
    .strict(),
});

export type WorkItemCloseInput = z.input<typeof workItemClose.input>;
export type WorkItemCloseOutput = z.output<typeof workItemClose.output>;
