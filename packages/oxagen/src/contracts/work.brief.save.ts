/**
 * save_work_brief: a person saves a new revision of a work item's acceptance
 * brief (agent-work-phase-1.html, Data contract). Existing criteria keep their
 * ids and new ones take the next unused numbers. Editing an approved brief
 * moves the item to its next revision, so it leaves ready until a person
 * approves again. A person decides it, signed in to Oxagen: an API key or an
 * agent run is refused, so an agent cannot decide its own work. The action
 * names the item version the person read, and the store refuses it when the
 * item changed since (ADR-244, ADR-251).
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { WORK_ACTION_CRITERION_TAGS, WORK_ACTION_INTENTS, WORK_ACTION_PROVENANCES, workDigestSchema, workItemIdSchema, workItemVersionSchema, workRevisionSchema, workWriteOutputShape } from "./work.order.shared";

/** One criterion as a person writes it. A new criterion has no id. */
const criterionSchema = z
  .object({
    /** The criterion's id from an earlier revision, to keep it. Omit for a new criterion. */
    id: z.string().regex(/^c[1-9][0-9]{0,5}$/).nullish(),
    text: z.string().trim().min(1).max(2000),
    tag: z.enum(WORK_ACTION_CRITERION_TAGS),
    intent: z.enum(WORK_ACTION_INTENTS),
    evidence: z.string().max(1000).nullish(),
    provenance: z.enum(WORK_ACTION_PROVENANCES),
  })
  .strict();

export const workBriefSave = registerCapability({
  name: "save_work_brief",
  domain: "work",
  description:
    "Save a new revision of a work item's acceptance brief: the repository the work changes and the criteria a reviewer checks.",
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
  audit: { targetKind: "work_item", targetIdField: "item_id" },
  input: z
    .object({
      item_id: workItemIdSchema,
      /** The item version the person read. */
      version: workItemVersionSchema,
      /** The item revision the editor read. */
      item_revision: workRevisionSchema,
      /** The repository the work changes, as owner/name. */
      repository: z.string().min(3).max(140),
      criteria: z.array(criterionSchema).min(1).max(40),
    })
    .strict(),
  output: z
    .object({
      ...workWriteOutputShape,
      brief: z.object({ revision: workRevisionSchema, digest: workDigestSchema }).strict(),
    })
    .strict(),
});

export type WorkBriefSaveInput = z.input<typeof workBriefSave.input>;
export type WorkBriefSaveOutput = z.output<typeof workBriefSave.output>;
