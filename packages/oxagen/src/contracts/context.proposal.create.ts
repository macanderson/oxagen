// propose_record — a proposal on a lineage: the record it should become, why,
// and the support it cites (ADR-061; MC spec §9.2, App. E). A proposal steers
// nothing; it is published when its Context PR merges (spec §10.3).
import { z } from "zod";
import { registerCapability } from "../registry";
import {
  proposalSupportSchema,
  proposedRecordSchema,
} from "./context.steering.shared";

export const contextProposalCreate = registerCapability({
  name: "propose_record",
  domain: "context",
  description:
    "Open a proposal on a lineage: the record it should become (kind, force, constraint effect, scope, statement), the rationale and the supporting runs, agents, records and evidence. Steers nothing until its Context PR merges.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  agent: {
    requiresApproval: false,
    riskLevel: "medium",
    category: "governance",
  },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z
    .object({
      record: proposedRecordSchema,
      rationale: z.string().min(1).max(4000),
      /**
       * Who raised it, as the page prints it (a job, a run, a person). Defaults
       * to the calling principal.
       */
      source: z.string().min(1).max(200).optional(),
      support: proposalSupportSchema.default({}),
      /**
       * Refuse a lineage that already names a record or a proposal, instead
       * of proposing a new version of it. A create sets it: a label need not
       * be unique, so two records can derive the same slug, and a new record
       * must never revise the one that holds it (ADR-178).
       */
      createOnly: z.boolean().optional(),
    })
    .strict(),
  output: z
    .object({
      proposalId: z.string(),
      lineageId: z.string(),
      status: z.literal("proposed"),
    })
    .strict(),
});

export type ContextProposalCreateInput = z.output<
  typeof contextProposalCreate.input
>;
export type ContextProposalCreateOutput = z.output<
  typeof contextProposalCreate.output
>;
