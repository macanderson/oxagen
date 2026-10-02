/**
 * reopen_work_item: a person reopens a closed or done work item with a reason.
 * Every earlier fact stays in its history. The item moves to its next
 * revision, its brief goes back to a draft, and the next send is a fresh
 * delivery on a newly approved revision. A person decides it, signed in to
 * Oxagen: an API key or an agent run is refused, so an agent cannot decide its
 * own work. The action names the item version the person read, and the store
 * refuses it when the item changed since (ADR-244, ADR-251).
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { workItemIdSchema, workItemVersionSchema, workReasonSchema, workWriteOutputShape } from "./work.order.shared";

export const workItemReopen = registerCapability({
  name: "reopen_work_item",
  domain: "work",
  description:
    "Reopen a closed or done work item. Its history stays, and its brief goes back to a draft.",
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
      reason: workReasonSchema,
    })
    .strict(),
  output: z
    .object({
      ...workWriteOutputShape,
    })
    .strict(),
});

export type WorkItemReopenInput = z.input<typeof workItemReopen.input>;
export type WorkItemReopenOutput = z.output<typeof workItemReopen.output>;
