import { z } from "zod";
import { registerCapability } from "../registry";

// Provenance entries reuse the ContextProvenanceV1 field vocabulary
// (packages/run-evidence/src/contextgraph.ts) rather than inventing a
// parallel shape.
const provenanceEntry = z
  .object({
    type: z.string().describe("Provenance kind (e.g. file, commit, review)"),
    uri: z.string().optional(),
    range: z.string().optional(),
    digest: z.string().optional(),
    method: z.string().optional(),
    by: z.string().optional(),
  })
  .strict();

export const contextRecordPublish = registerCapability({
  name: "publish_context_record",
  domain: "context",
  description:
    "Publish a steering context record into the workspace agent-asset registry — upserts the agent.context_records row by (workspace, record_id) and creates a new immutable version row when the canonical body changed. Idempotent on an unchanged body. Mirrors Stella's one-record-per-file .stella/rules/*.toml layout.",
  mode: "sync",
  surfaces: ["api"],
  layers: ["schema", "api", "docs", "unit"],
  scoped: true,
  noBillingGate: true,
  agent: { requiresApproval: true, riskLevel: "high", category: "governance" },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Admin: "allow" },
  },
  input: z
    .object({
      record_id: z
        .string()
        .min(1)
        .describe(
          "The record's stable id — the .stella/rules/<record_id>.toml file stem; the workspace-unique key",
        ),
      title: z.string().min(1).describe("Human-readable record title"),
      body: z
        .string()
        .min(1)
        .describe("The canonical record body (one TOML record per file)"),
      provenance: z
        .array(provenanceEntry)
        .optional()
        .describe(
          "Where this record came from (ContextProvenanceV1 vocabulary)",
        ),
    })
    .strict(),
  output: z
    .object({
      publicId: z.string().describe("Public record ID (ctr_…)"),
      recordId: z.string().describe("The record's stable id (slug)"),
      version: z.number().int().positive(),
      checksum: z.string().describe("SHA-256 hex over the body"),
      published: z
        .boolean()
        .describe(
          "false when the latest version already carries this checksum (idempotent)",
        ),
    })
    .strict(),
});

export type ContextRecordPublishInput = z.output<
  typeof contextRecordPublish.input
>;
export type ContextRecordPublishOutput = z.output<
  typeof contextRecordPublish.output
>;
