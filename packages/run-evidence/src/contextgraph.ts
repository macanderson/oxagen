import { z } from "zod";

export const CONTEXTGRAPH_PROTOCOL_VERSION = "contextgraph/1.0-draft" as const;
export const CONTEXTGRAPH_FIXTURE_PROFILE_VERSION = "1.1.0" as const;

const u32Schema = z.number().int().min(0).max(0xffff_ffff);
const finiteNumberSchema = z.number().finite();

export const contextFrameKindV1Schema = z.enum([
  "snippet",
  "symbol",
  "fact",
  "doc",
  "memory",
  "episode",
  "graph",
]);

export const contextProvenanceV1Schema = z
  .object({
    type: z.string(),
    uri: z.string().optional(),
    range: z.string().optional(),
    digest: z.string().optional(),
    method: z.string().optional(),
    by: z.string().optional(),
  })
  .strict();

export const contextFrameEmbeddingV1Schema = z
  .object({
    fingerprint: z.string(),
    vector: z.array(finiteNumberSchema).optional(),
  })
  .strict();

export const contextRelationV1Schema = z
  .object({
    rel: z.string(),
    target_uri: z.string(),
    display_name: z.string().optional(),
  })
  .strict();

export const contextFrameV1Schema = z
  .object({
    id: z.string(),
    kind: contextFrameKindV1Schema,
    title: z.string(),
    content: z.string(),
    uri: z.string().optional(),
    score: finiteNumberSchema.min(0).max(1),
    token_cost: u32Schema,
    valid_from: z.string().optional(),
    valid_to: z.string().optional(),
    recorded_at: z.string().optional(),
    provenance: z.array(contextProvenanceV1Schema).default([]),
    citation_label: z.string().refine((value) => value.trim().length > 0, {
      message: "citation_label must not be blank",
    }),
    embedding: contextFrameEmbeddingV1Schema.optional(),
    relations: z.array(contextRelationV1Schema).default([]),
  })
  .strict();

export const contextQueryV1Schema = z
  .object({
    goal: z.string(),
    query_text: z.string().optional(),
    embedding: z.array(finiteNumberSchema).optional(),
    kinds: z.array(contextFrameKindV1Schema).default([]),
    anchors: z.array(z.string()).default([]),
    max_frames: u32Schema,
    max_tokens: u32Schema,
    as_of: z.string().optional(),
  })
  .strict();

export type ContextFrameKindV1 = z.infer<typeof contextFrameKindV1Schema>;
export type ContextProvenanceV1 = z.infer<typeof contextProvenanceV1Schema>;
export type ContextFrameEmbeddingV1 = z.infer<
  typeof contextFrameEmbeddingV1Schema
>;
export type ContextRelationV1 = z.infer<typeof contextRelationV1Schema>;
export type ContextFrameV1 = z.infer<typeof contextFrameV1Schema>;
export type ContextQueryV1 = z.infer<typeof contextQueryV1Schema>;

export function normalizeContextFrameV1(input: unknown): ContextFrameV1 {
  return contextFrameV1Schema.parse(input);
}

export function normalizeContextQueryV1(input: unknown): ContextQueryV1 {
  return contextQueryV1Schema.parse(input);
}
