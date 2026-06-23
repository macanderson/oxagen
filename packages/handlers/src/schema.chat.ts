import type { CapabilityHandler } from "@oxagen/oxagen";
import { schemaChat } from "@oxagen/oxagen/contracts/schema.chat";
import { generateObjectFor } from "@oxagen/ai";
import { z } from "zod";
import { logger } from "./logger";

const chatResponseSchema = z.object({
  assistantMessage: z
    .string()
    .describe("The assistant's response explaining the proposed changes"),
  proposedMutations: z
    .array(
      z.object({
        capability: z
          .string()
          .describe("Contract name, e.g. schema.label.upsert, schema.relationship.upsert"),
        input: z.record(z.string(), z.unknown()),
      }),
    )
    .optional()
    .describe("Proposed mutation tool calls the user can review and apply"),
});

export const schemaChatHandler: CapabilityHandler<typeof schemaChat> = async (input, ctx) => {
  const conversationId = input.conversationId ?? crypto.randomUUID();

  const system = `You are an expert knowledge graph schema designer. You help users build and refine their workspace schema registry.

You have access to these mutation capabilities:
- schema.label.upsert: Create/update a node label with properties
- schema.label.delete: Remove a node label
- schema.relationship.upsert: Create/update a relationship type
- schema.relationship.delete: Remove a relationship type
- schema.property.upsert: Add/update a property on a label or relationship type
- schema.property.delete: Remove a property
- schema.toggle: Enable/disable a schema (auto-publishes the draft)
- schema.registry.config: Set enforcement mode and conformance floor

When proposing changes, include them as proposedMutations. Always explain what you're proposing and why. Do NOT apply mutations directly — return them as proposals for the user to review.

Conversation ID: ${conversationId}
Draft version: ${input.draftVersionId ?? "current draft"}`;

  const { object } = await generateObjectFor({
    schema: chatResponseSchema,
    prompt: input.message,
    system,
    telemetry: {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      surface: ctx.surface,
      messageId: ctx.messageId ?? null,
    },
  });

  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      conversationId,
      mutationCount: object.proposedMutations?.length ?? 0,
    },
    "schema.chat: generated response",
  );

  return {
    assistantMessage: object.assistantMessage,
    proposedMutations: object.proposedMutations,
    conversationId,
  };
};
