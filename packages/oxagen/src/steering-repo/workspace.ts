// workspace.ts: `workspace/v1`, the steering repo's workspace.toml
// (steering-repo-spec, Scope and binding; mcp-studio-spec, Embedding
// endpoint). An organization repo has no workspace.toml.
import { z } from "zod";
import {
  credentialRefSchema,
  organizationSlugSchema,
  repoRefSchema,
  workspaceSlugSchema,
} from "./common";
import { uniqueArray, withRules } from "./json-schema";

/** Who ranks search mode's results: Voyage on Oxagen's key, the workspace's own endpoint, or keywords. */
export const embeddingProviderSchema = z.enum(["oxagen", "custom", "keyword"]);
export type EmbeddingProvider = z.output<typeof embeddingProviderSchema>;

/**
 * `[embeddings]`: the provider search mode ranks with. Unset, the provider is
 * `oxagen`. A `custom` provider names its endpoint and model, and its key as
 * a credential reference. The other two take nothing else.
 */
export const embeddingsSchema = withRules(
  z
    .object({
      provider: embeddingProviderSchema.optional(),
      url: z
        .string()
        .url()
        .optional()
        .describe(
          "An endpoint that takes Voyage's request shape: model and input.",
        ),
      model: z.string().min(1).max(200).optional(),
      credential: credentialRefSchema.optional(),
    })
    .strict(),
  [
    {
      kind: "require",
      when: { field: "provider", is: "custom" },
      fields: ["url", "model"],
    },
    {
      kind: "forbid",
      when: { field: "provider", isNot: "custom" },
      fields: ["url", "model", "credential"],
    },
  ],
);

export const workspaceSchema = z
  .object({
    schema: z.literal("workspace/v1"),
    organization: organizationSlugSchema,
    workspace: workspaceSlugSchema,
    repositories: uniqueArray(
      z.object({ url: repoRefSchema }).strict(),
      "repositories",
    )
      .optional()
      .describe(
        "The linked code repositories. Linking one is a steering PR that adds it here.",
      ),
    budget: z
      .object({
        per_month_micros: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("The workspace's monthly spend limit, in millionths of a dollar."),
      })
      .strict()
      .optional(),
    code_checks: z
      .object({
        block_merge: z
          .boolean()
          .optional()
          .describe("true: a finding fails the Oxagen check on a code repository."),
      })
      .strict()
      .optional(),
    tools: z
      .object({
        definition_budget: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Warn past this many tokens of direct-mode tool definitions. 20,000 when unset.",
          ),
      })
      .strict()
      .optional(),
    embeddings: embeddingsSchema.optional(),
  })
  .strict();
export type WorkspaceFile = z.output<typeof workspaceSchema>;
