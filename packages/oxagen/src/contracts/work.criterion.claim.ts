/**
 * claim_work_criterion: the agent working a send says it met one criterion of
 * the brief on the pull request's head commit (ADR-244, ADR-251).
 *
 * A claim is the agent's word. The work item shows it beside the criterion,
 * and it moves nothing: a person still ticks every criterion and accepts the
 * head. A claim names the head commit it was made on, so a new head leaves the
 * claim on the old one.
 *
 * Only the agent working the send may claim. The caller is the run linked to
 * the send, or the key of the host that claimed the send, and the claim is
 * filed as that linked run. A person, any other key, and any other run are
 * refused. The same claim again on the same head records nothing new.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import {
  workHeadShaSchema,
  workItemIdSchema,
  workOrderAfterSchema,
  workOrderIdSchema,
  workWriteOutputShape,
} from "./work.order.shared";

/** A brief criterion id: `c` and a number from 1 (`CRITERION_ID_PATTERN` in @oxagen/work/records). */
const workCriterionIdSchema = z.string().regex(/^c[1-9][0-9]{0,5}$/, "a criterion id is c and a number, such as c1");

export const workCriterionClaim = registerCapability({
  name: "claim_work_criterion",
  domain: "work",
  description:
    "Claim, as the agent working a send, that one criterion of the brief is met on the pull request's head commit. A person still decides.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
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
      item_id: workItemIdSchema,
      work_order_id: workOrderIdSchema,
      /** The criterion of the brief the send went out with. */
      criterion_id: workCriterionIdSchema,
      /** The pull request's head commit the claim is about. */
      head_sha: workHeadShaSchema,
      /** How the agent met the criterion, in a short statement. */
      text: z.string().trim().min(1).max(2000),
    })
    .strict(),
  output: z
    .object({
      ...workWriteOutputShape,
      order: workOrderAfterSchema,
      claim: z
        .object({
          criterion_id: workCriterionIdSchema,
          head_sha: workHeadShaSchema,
          /** The run the claim is filed as: the run linked to the send. */
          run_id: z.string(),
        })
        .strict(),
    })
    .strict(),
});

export type WorkCriterionClaimInput = z.input<typeof workCriterionClaim.input>;
export type WorkCriterionClaimOutput = z.output<typeof workCriterionClaim.output>;
