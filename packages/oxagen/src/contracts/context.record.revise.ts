// revise_context_record — change the statement of a record that is in force,
// as a pull request (ADR-061; MC spec §10.2, §10.3).
//
// A published record is the file `.oxagen/rules/<lineage>.toml` on the
// production branch, and nothing but a merge changes what is in force. So an
// revision is not a write: it raises a proposal carrying the record's kind,
// force, effect and scope unchanged with the new statement, and opens the
// Context PR that publishes it — the same branch, the same file, the same six
// §10.3 checks, the same merge. The record keeps its lineage, because an
// revised record is the same record, not a new one; `record_id` and
// `record_hash` are recomputed over the new bytes, and the old hash stays true
// of every run that carried the old ones.
//
// This exists so that the one thing a reader can do to a record from the
// record's own page ends where every other steering change ends: on a pull
// request somebody merges. The caller supplies only the statement. Changing a
// record's kind, force or effect is a different record and goes through
// `propose_record`.
import { z } from "zod";
import { registerCapability } from "../registry";
import { contextPrSchema } from "./context.pr.open";

export const contextRecordRevise = registerCapability({
  name: "revise_context_record",
  domain: "context",
  description:
    "Revise a published record's statement: raise a proposal carrying its kind, force, effect and scope unchanged, and open the Context PR that publishes the new wording. The lineage is kept; nothing is in force until the pull request merges.",
  mode: "sync",
  // The handler acts as the signed-in user (resolveActingUserId,
  // assertOrgRole, INV-29), like every other steering write. The API alone:
  // an agent that wants a record changed writes a `record_proposal` append.
  surfaces: ["api"],
  layers: ["schema", "api", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  agent: { requiresApproval: true, riskLevel: "high", category: "governance" },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z
    .object({
      /** The lineage of the record to revise, or its `ctr_` public id. */
      recordId: z.string().min(1).max(200),
      /** The new statement. The only field an revision changes. */
      statement: z.string().min(1).max(2000),
      /** Why it is being changed; recorded on the proposal and in the PR body. */
      rationale: z.string().min(1).max(4000).optional(),
    })
    .strict(),
  output: contextPrSchema,
});

export type ContextRecordReviseInput = z.output<typeof contextRecordRevise.input>;
export type ContextRecordReviseOutput = z.output<
  typeof contextRecordRevise.output
>;
