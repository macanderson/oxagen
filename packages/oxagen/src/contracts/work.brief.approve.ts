/**
 * approve_work_brief: a person approves the latest brief revision for the work
 * item's current revision. The approval names the brief's digest, and an
 * approved brief never changes: an edit is a new revision. Approving needs no
 * open triage question and no unresolved duplicate. A repeat of the same
 * approval changes nothing. A person decides it, signed in to Oxagen: an API
 * key or an agent run is refused, so an agent cannot decide its own work. The
 * action names the item version the person read, and the store refuses it when
 * the item changed since (ADR-244, ADR-251).
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { workDigestSchema, workItemIdSchema, workItemVersionSchema, workRevisionSchema, workWriteOutputShape } from "./work.order.shared";

export const workBriefApprove = registerCapability({
  name: "approve_work_brief",
  domain: "work",
  description:
    "Approve the latest acceptance brief for a work item's current revision, so the item can be sent to an agent.",
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
      item_revision: workRevisionSchema,
      brief_revision: workRevisionSchema,
      brief_digest: workDigestSchema,
    })
    .strict(),
  output: z
    .object({
      ...workWriteOutputShape,
    })
    .strict(),
});

export type WorkBriefApproveInput = z.input<typeof workBriefApprove.input>;
export type WorkBriefApproveOutput = z.output<typeof workBriefApprove.output>;
