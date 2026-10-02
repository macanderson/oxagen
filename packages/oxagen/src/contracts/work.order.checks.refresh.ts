/**
 * refresh_work_order_checks: Oxagen reads again, from GitHub, the checks a
 * send's pull request needs on its current head commit, and records what it
 * read (P1-04, ADR-251).
 *
 * It reads the checks the base branch requires (branch protection and
 * rulesets) and each check's latest conclusion on the head. A required list
 * is recorded only when both reads succeeded, so a failed read never stands in
 * for "no check is required", which would open Accept on ticks alone. The
 * facts are the provider's, never the caller's, and a read that finds nothing
 * new records nothing. accept_work_order makes the same read at the press.
 *
 * A signed-in person who may accept work calls it, from the work item's page.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { workHeadShaSchema, workItemIdSchema, workOrderIdSchema, workWriteOutputShape } from "./work.order.shared";

export const workOrderChecksRefresh = registerCapability({
  name: "refresh_work_order_checks",
  domain: "work",
  description:
    "Read again from GitHub the checks a send's pull request needs on its head commit, and record the required checks and each conclusion.",
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
      work_order_id: workOrderIdSchema,
    })
    .strict(),
  output: z
    .object({
      ...workWriteOutputShape,
      /** The head commit the read was for, or null when the send has no pull request yet. */
      head_sha: workHeadShaSchema.nullable(),
      /** The checks the base branch requires on the head. Null when Oxagen could not read them. */
      required_checks: z.array(z.string()).nullable(),
      /** Why the required checks could not be read, when they could not. */
      unread_reason: z.string().nullable(),
    })
    .strict(),
});

export type WorkOrderChecksRefreshInput = z.input<typeof workOrderChecksRefresh.input>;
export type WorkOrderChecksRefreshOutput = z.output<typeof workOrderChecksRefresh.output>;
