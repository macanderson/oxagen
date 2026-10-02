/**
 * retry_work_triage: a person asks triage to run again on one work item
 * (P1-03, #5103). Use it after triage recorded a failure, or after the
 * priorities record changed.
 *
 * The run is queued with the workspace's other triage runs, at most 60 a
 * minute. It runs only while the item is new, held, triaged, needs_info, or
 * changed, and a person's corrections stay in force whatever it suggests.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { workItemIdSchema, workItemStateSchema } from "./work.intake.shared";

export const workTriageRetry = registerCapability({
  name: "retry_work_triage",
  domain: "work",
  description:
    "Queue triage to run again on a work item, after a failure or a change to the priorities record. A person's corrections stay in force.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({ item_id: workItemIdSchema }).strict(),
  output: z
    .object({
      item_id: workItemIdSchema,
      state: workItemStateSchema,
      /** True when the run was queued. */
      queued: z.literal(true),
    })
    .strict(),
});

export type WorkTriageRetryInput = z.output<typeof workTriageRetry.input>;
export type WorkTriageRetryOutput = z.output<typeof workTriageRetry.output>;
