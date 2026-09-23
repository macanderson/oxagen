import { z } from "zod";
import { registerCapability } from "../registry";
import {
  constraintEffectSchema,
  recordForceSchema,
  recordKindSchema,
} from "./context.steering.shared";

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

// The base shape, exported so a caller that needs individual fields (e.g.
// `.shape.title`) can reach them without unwrapping the `superRefine` below —
// `ZodEffects` (what `.superRefine` returns) drops the `.shape` accessor that
// a plain `ZodObject` carries.
export const contextRecordPublishShape = z
  .object({
    record_id: z
      .string()
      .min(1)
      .describe(
        "The record's stable id — the .stella/rules/<record_id>.toml file stem; the workspace-unique key",
      ),
    title: z.string().min(1).describe("Human-readable record title"),
    label: z.string().trim().min(1).max(200).optional(),
    body: z
      .string()
      .min(1)
      .describe("The canonical record body (one TOML record per file)"),
    kind: recordKindSchema.describe("The kind this version's body declares"),
    force: recordForceSchema.describe(
      "How hard the record steers: must, should, may, or info — only must/should ever reach an agent",
    ),
    /** Required on a constraint, refused on every other kind. */
    constraintEffect: constraintEffectSchema.optional(),
    statement: z
      .string()
      .min(1)
      .max(2000)
      .describe("The single-sentence claim the record makes"),
    provenance: z
      .array(provenanceEntry)
      .optional()
      .describe("Where this record came from (ContextProvenanceV1 vocabulary)"),
  })
  .strict();

export const contextRecordPublish = registerCapability({
  name: "publish_context_record",
  domain: "context",
  description:
    "Publish a steering context record into the workspace agent-asset registry. Upserts the agent.context_records row by (workspace, record_id) and writes a new immutable version row whenever the body checksum or the classification (kind, force, constraintEffect, statement) differs from the latest version. A publish that repeats all five is idempotent and answers published: false. The checksum alone is not the key: a record whose classification was wrong is corrected by republishing the same body under the right kind and force, and that correction has to land as a new version or the record never reaches readWorkspaceSteering. Mirrors Stella's one-record-per-file .stella/rules/*.toml layout. Requires the same classification a merged Context PR carries (#3302), because readWorkspaceSteering only ever delivers a must or should record to an agent: a record with no force sits in the registry and never steers anything.",
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
  input: contextRecordPublishShape.superRefine((r, ctx) => {
    if (r.kind === "constraint" && r.constraintEffect === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["constraintEffect"],
        message: "a constraint declares require or forbid",
      });
    }
    if (r.kind !== "constraint" && r.constraintEffect !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["constraintEffect"],
        message: "only a constraint carries an effect",
      });
    }
  }),
  output: z
    .object({
      publicId: z.string().describe("Public record ID (ctr_…)"),
      recordId: z.string().describe("The record's stable id (slug)"),
      version: z.number().int().positive(),
      checksum: z.string().describe("SHA-256 hex over the body"),
      published: z
        .boolean()
        .describe(
          "false when the latest version already carries this body checksum AND this classification (kind, force, constraintEffect, statement); true when either changed and a new version was written",
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
