// steering-tools.ts: the input and output of the two steering tools an agent
// calls over MCP, search_steering and read_steering (steering-repo-spec,
// Agent use).
//
// The contracts in src/contracts/steering.search.ts and steering.read.ts
// register these shapes, and @oxagen/steering-bundle answers them. They live
// here because the bundle depends on this package, so a contract cannot
// import them from the bundle.
import { z } from "zod";
import { lineageSchema, repoRefSchema } from "./common";
import { recordKindSchema } from "./record-kind";

export const STEERING_SEARCH_DEFAULT_LIMIT = 10;
export const STEERING_SEARCH_MAX_LIMIT = 50;

export const steeringSearchInputSchema = z
  .object({
    query: z
      .string()
      .max(500)
      .optional()
      .describe("Words to look for in each record's label, description, and lineage."),
    kind: recordKindSchema.optional().describe("Only records of this kind, such as skill."),
    repository: repoRefSchema
      .optional()
      .describe("Only records that reach a run on this code repository, such as github.com/a-intel/platform."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(STEERING_SEARCH_MAX_LIMIT)
      .optional()
      .describe(`How many to return. ${STEERING_SEARCH_DEFAULT_LIMIT} when unset.`),
  })
  .strict();
export type SteeringSearchInput = z.input<typeof steeringSearchInputSchema>;

export const steeringSearchHitSchema = z
  .object({
    lineage: z.string(),
    label: z.string(),
    description: z.string().optional(),
    kind: z.string(),
    force: z.string(),
    /** True for a record every request of a run on the repository already receives. */
    always_on: z.boolean(),
    source: z.enum(["workspace", "organization"]),
    line: z.string().describe("The record's index line."),
  })
  .strict();
export type SteeringSearchHit = z.output<typeof steeringSearchHitSchema>;

export const steeringSearchOutputSchema = z
  .object({
    workspace_version: z.number().int().nullable(),
    organization_version: z.number().int().nullable(),
    hits: z.array(steeringSearchHitSchema),
    /** How many matched before the limit. */
    total: z.number().int().min(0),
  })
  .strict();
export type SteeringSearchOutput = z.output<typeof steeringSearchOutputSchema>;

export const steeringReadInputSchema = z
  .object({
    lineage: lineageSchema.describe("The record or skill to read, such as a-intel.domain.refund."),
    file: z
      .string()
      .min(1)
      .max(512)
      .optional()
      .describe("A file in the skill's folder, such as words.md. Unset, the record itself."),
  })
  .strict();
export type SteeringReadInput = z.input<typeof steeringReadInputSchema>;

export const steeringReadOutputSchema = z
  .object({
    lineage: z.string(),
    label: z.string(),
    kind: z.string(),
    source: z.enum(["workspace", "organization"]),
    version: z.number().int().min(1),
    path: z.string(),
    text: z.string(),
  })
  .strict();
export type SteeringReadOutput = z.output<typeof steeringReadOutputSchema>;
