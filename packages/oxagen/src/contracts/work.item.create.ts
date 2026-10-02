/**
 * create_work_item: a person enters a work item by hand (P1-03, #5103;
 * agent-work-phase-1.html, Work lifecycle: Collect).
 *
 * The item takes the workspace's next number (`WI-<n>`), records an `entered`
 * fact on revision 1, and goes to triage like an item a collector brought
 * in. The text is screened for credentials before it is stored. An item
 * entered here has no provider, so nothing writes back anywhere.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { repositoryNameSchema, workItemIdSchema, workItemStateSchema } from "./work.intake.shared";

/** The longest subject and description a person can enter. */
export const WORK_ITEM_SUBJECT_MAX = 300;
export const WORK_ITEM_DESCRIPTION_MAX = 20_000;
/** The most labels, and the longest label. */
export const WORK_ITEM_LABELS_MAX = 20;
export const WORK_ITEM_LABEL_MAX = 100;

export const workItemCreate = registerCapability({
  name: "create_work_item",
  domain: "work",
  description:
    "Enter a work item by hand: a subject, an optional description and labels, and the repository it belongs to. Triage reads it next.",
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
  input: z
    .object({
      subject: z.string().trim().min(1).max(WORK_ITEM_SUBJECT_MAX),
      description: z.string().max(WORK_ITEM_DESCRIPTION_MAX).optional(),
      labels: z
        .array(z.string().trim().min(1).max(WORK_ITEM_LABEL_MAX))
        .max(WORK_ITEM_LABELS_MAX)
        .default([]),
      repository: repositoryNameSchema.optional().describe("The repository the work belongs to, as owner/name."),
    })
    .strict(),
  output: z
    .object({
      item_id: workItemIdSchema,
      /** The workspace's number for the item, such as WI-19. */
      number: z.string(),
      state: workItemStateSchema,
      /** The item revision: 1 for a new item. */
      revision: z.number().int().positive(),
      /** The concurrency token a later action names. */
      version: z.number().int().nonnegative(),
    })
    .strict(),
});

export type WorkItemCreateInput = z.output<typeof workItemCreate.input>;
export type WorkItemCreateOutput = z.output<typeof workItemCreate.output>;
