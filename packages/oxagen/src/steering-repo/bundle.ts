// bundle.ts: `bundle/v1`, what the cloud gateway and session start read for
// one published version of a steering repo (steering-repo-spec, Shared
// contract and Token efficiency).
//
// Publishing builds it from the merged tree: the record index with token
// counts, the rendered always-on block for each code repository, the Cedar
// policy set, the agents, and the tool manifest. The tool manifest's schema,
// `tool-manifest/v1`, belongs to MCP Studio (lane M0), so this schema checks
// only that the slot names it, and the published JSON Schema points at it.
import { z } from "zod";
import { agentSchema } from "./agent";
import {
  gitObjectIdSchema,
  instantSchema,
  lineageSchema,
  organizationSlugSchema,
  recordIdSchema,
  repoPathSchema,
  repoRefSchema,
  sha256Schema,
  toolTargetSchema,
  workspaceSlugSchema,
} from "./common";
import { withJsonSchema, withRules } from "./json-schema";
import {
  recordEffectSchema,
  recordForceSchema,
  recordKindSchema,
  recordLoadSchema,
  recordScopeSchema,
} from "./record";
import { schemaUrl } from "./schema-ids";

const tokensSchema = z.number().int().min(0);

/** One active record in the published version. The body stays in the repository, found by `blob`. */
export const bundleRecordSchema = z
  .object({
    lineage: lineageSchema,
    path: repoPathSchema,
    blob: gitObjectIdSchema.describe("The record file's blob, so a publish recompiles only changed files."),
    id: recordIdSchema,
    hash: sha256Schema,
    label: z.string().min(1),
    description: z.string().optional(),
    kind: recordKindSchema,
    name: z.string().optional(),
    effect: recordEffectSchema.optional(),
    force: recordForceSchema,
    scope: recordScopeSchema,
    load: recordLoadSchema.describe("The load in force: the record's own, or the one its force implies."),
    repos: z.array(repoRefSchema).optional(),
    tools: z.array(toolTargetSchema).optional(),
    applies_to: z.array(z.string()).optional(),
    tokens: tokensSchema.describe("The record as delivered: its label as a heading, then its body."),
    index_tokens: tokensSchema.describe("The record's one index line."),
    files: z
      .array(z.object({ path: repoPathSchema, blob: gitObjectIdSchema }).strict())
      .optional()
      .describe("A skill's other files."),
  })
  .strict();
export type BundleRecord = z.output<typeof bundleRecordSchema>;

/** The records that reach every request of a run on one code repository, rendered once. */
export const alwaysOnBlockSchema = z
  .object({
    repository: repoRefSchema
      .nullable()
      .describe("The code repository, or null for a run on a repository no record names."),
    text: z.string(),
    tokens: tokensSchema,
    lineages: z.array(lineageSchema).describe("The records in the block, in its order."),
  })
  .strict();

/** The Cedar policy set, validated against its schema when the version was published. */
export const policySetSchema = z
  .object({
    schema: z.string().describe("policy/schema.cedarschema."),
    policies: z.array(
      z
        .object({ path: repoPathSchema, blob: gitObjectIdSchema, text: z.string() })
        .strict(),
    ),
  })
  .strict();

/** The published tool manifest (`tool-manifest/v1`, MCP Studio's schema). */
const toolManifestSchema = withJsonSchema(
  z.object({ schema: z.literal("tool-manifest/v1") }).passthrough(),
  { $ref: schemaUrl("tool-manifest/v1") },
);

export const bundleSchema = withRules(
  z
    .object({
      schema: z.literal("bundle/v1"),
      repository: repoRefSchema.describe("The steering repo, or the organization repo."),
      scope: z.enum(["workspace", "organization"]),
      organization: organizationSlugSchema,
      workspace: workspaceSlugSchema.optional(),
      version: z
        .number()
        .int()
        .min(1)
        .describe("The published version: one more than the last, per repository."),
      commit: gitObjectIdSchema.describe("The merge commit the version was built from."),
      ledger: z
        .object({
          path: repoPathSchema,
          seq: z.number().int().min(1),
          hash: sha256Schema,
        })
        .strict()
        .nullable()
        .describe("The ledger line of the merge, or null for version 1, which no steering PR made."),
      published_at: instantSchema,
      records: z.array(bundleRecordSchema),
      always_on: z.array(alwaysOnBlockSchema),
      policies: policySetSchema.nullable().describe("Null when the repository has no policy/ folder."),
      agents: z.array(agentSchema),
      tools: toolManifestSchema
        .nullable()
        .describe("Null until the tools compile, or when the repository has no servers."),
    })
    .strict(),
  [
    {
      kind: "require",
      when: { field: "scope", is: "workspace" },
      fields: ["workspace"],
    },
    {
      kind: "forbid",
      when: { field: "scope", is: "organization" },
      fields: ["workspace"],
    },
  ],
);
export type Bundle = z.output<typeof bundleSchema>;
