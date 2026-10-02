/**
 * accept_work_order: a person accepts a send's result on the pull request's
 * exact head commit. Oxagen reads the checks the base branch requires on that
 * head again at the press, and records what it read. A required check that is
 * missing, failing, cancelled, skipped, or unread blocks the acceptance. When
 * the base branch requires no check, the acceptance rests on the person's tick
 * for every criterion and names the head commit (oxageninc/roadmap#279).
 * Acceptance merges nothing: the item is done once the pull request merges
 * too, in either order. A new head commit voids the acceptance. A person
 * decides it, signed in to Oxagen: an API key or an agent run is refused, so
 * an agent cannot decide its own work. The action names the item version the
 * person read, and the store refuses it when the item changed since (ADR-244,
 * ADR-251).
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { workDigestSchema, workHeadShaSchema, workItemIdSchema, workItemVersionSchema, workOrderAfterSchema, workOrderIdSchema, workWriteOutputShape } from "./work.order.shared";

export const workOrderAccept = registerCapability({
  name: "accept_work_order",
  domain: "work",
  description:
    "Accept a send's result on the pull request's head commit, with every criterion ticked. Acceptance merges nothing.",
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
      /** The head commit the person reviewed. */
      head_sha: workHeadShaSchema,
      /** The approved brief the person accepted against. */
      brief_digest: workDigestSchema,
      /** Every criterion id the person ticked. */
      criteria: z.array(z.string().regex(/^c[1-9][0-9]{0,5}$/)).max(40),
    })
    .strict(),
  output: z
    .object({
      ...workWriteOutputShape,
      order: workOrderAfterSchema,
      /** The checks the base branch required on the head when the person accepted. Empty when none. */
      required_checks: z.array(z.string()),
    })
    .strict(),
});

export type WorkOrderAcceptInput = z.input<typeof workOrderAccept.input>;
export type WorkOrderAcceptOutput = z.output<typeof workOrderAccept.output>;
