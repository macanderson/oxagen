import { z } from "zod";

/** Shared, human-readable citation shape for a workspace graph node. */
export const knowledgeNodeRefSchema = z.object({
  id: z
    .string()
    .nullable()
    .describe(
      "publicId of the node, or null when the cited node is not materialised",
    ),
  label: z.string().describe("Domain label or type"),
  displayName: z.string().describe("Human-readable name"),
  properties: z
    .record(z.string(), z.unknown())
    .default({})
    .describe("Full property bag for inspectable citations"),
});

export type KnowledgeNodeRef = z.output<typeof knowledgeNodeRefSchema>;
