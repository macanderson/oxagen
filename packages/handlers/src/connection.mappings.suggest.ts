import type { CapabilityHandler } from "@oxagen/oxagen";
import { connectionMappingsSuggest } from "@oxagen/oxagen/contracts/connection.mappings.suggest";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import { generateObjectFor, selectModel } from "@oxagen/ai";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { logger } from "./logger";

const SuggestionSchema = z.object({
  suggestions: z.array(
    z.object({
      sourceRecordType: z.string(),
      suggestedEntityType: z
        .string()
        .describe("snake_case entity type name e.g. task, code_change, document"),
      suggestedPropertyMappings: z.record(z.string()),
      confidence: z.number().min(0).max(1),
      reasoning: z.string(),
    }),
  ),
});

export const connectionMappingsSuggestHandler: CapabilityHandler<
  typeof connectionMappingsSuggest
> = async (input, ctx) => {
  // Verify connection ownership (scoped to org + workspace)
  const [conn] = await withTenantDb((tx) =>
    tx
      .select({ id: schema.sourceConnections.id })
      .from(schema.sourceConnections)
      .where(
        and(
          eq(schema.sourceConnections.publicId, input.connectionId),
          eq(schema.sourceConnections.orgId, ctx.orgId),
          eq(schema.sourceConnections.workspaceId, ctx.workspaceId),
        ),
      )
      .limit(1),
  );

  if (!conn) throw new HTTPException(404, { message: "Connection not found" });

  const existingTypesContext =
    input.existingEntityTypes && input.existingEntityTypes.length > 0
      ? `\n\nExisting entity types already defined in this workspace: ${input.existingEntityTypes.join(", ")}. Prefer reusing these names when they are a good fit.`
      : "";

  const prompt = `You are helping configure a data ingestion pipeline for an AI agent platform.

The user has connected a data source that exposes the following record types:
${input.recordTypes
  .map(
    (rt) => `
Record Type: ${rt.sourceRecordType} (${rt.displayName})
${rt.description ? `Description: ${rt.description}` : ""}
Sample fields: ${rt.sampleFields.join(", ")}
${rt.sampleRecords ? `Sample records: ${JSON.stringify(rt.sampleRecords.slice(0, 2), null, 2)}` : ""}
`,
  )
  .join("\n---\n")}
${existingTypesContext}

For each record type, suggest:
1. A snake_case entity type name (e.g. "task", "code_change", "contact", "document") — broad enough to work across multiple connectors
2. Field mappings: source field name → canonical property name (e.g. "user.login" → "author", "title" → "title")
3. Your confidence (0-1) in this mapping
4. A brief 1-2 sentence explanation shown to the user

Return suggestions for all ${input.recordTypes.length} record types.`;

  const result = await generateObjectFor({
    model: selectModel(),
    schema: SuggestionSchema,
    prompt,
    // One suggestion per record type — an entity-type name, a flat map of
    // field names, a number and a sentence or two. A connection with a dozen
    // record types is a large one and still lands far inside 8192 tokens.
    //
    // Bounded because the alternative is not "no cap" but "the model's cap".
    // Sending no max_tokens makes a metered provider reserve credit against
    // the full ceiling — 65536 for claude-sonnet-5 — regardless of how short
    // the answer will be, and OpenRouter refuses the call outright when the
    // balance cannot cover the reservation, before generating a token.
    //
    // The cost of this being wrong is visible rather than silent: too low and
    // the object is truncated, which fails SuggestionSchema and surfaces as a
    // failed suggestion, not as quietly missing mappings.
    maxOutputTokens: 8192,
    telemetry: {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      surface: ctx.surface,
      // requestId/messageId are UUIDs; null (not "unknown") when neither is
      // present — this id lands in token_usage's UUID column and credit_ledger's
      // uuid column.
      messageId: ctx.messageId ?? ctx.requestId ?? null,
    },
  });

  // Persist suggestions to DB so the user can accept/reject them
  const now = new Date();
  const inserted = await withTenantDb((tx) =>
    tx
      .insert(schema.setupSuggestions)
      .values(
        result.object.suggestions.map((s: z.infer<typeof SuggestionSchema>["suggestions"][number]) => ({
          publicId: `sug_${Date.now().toString(36)}_${s.sourceRecordType}`,
          connectionId: conn.id,
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
          sourceRecordType: s.sourceRecordType,
          suggestedEntityType: s.suggestedEntityType,
          suggestedPropertyMappings: s.suggestedPropertyMappings,
          reasoning: s.reasoning,
          status: "pending" as const,
          createdAt: now,
        })),
      )
      .returning({ publicId: schema.setupSuggestions.publicId }),
  );

  logger.info(
    {
      connectionId: conn.id,
      suggestionCount: result.object.suggestions.length,
      orgId: ctx.orgId,
    },
    "connection.mappings.suggest: generated suggestions",
  );

  return {
    suggestions: result.object.suggestions,
    suggestionIds: inserted.map((r) => r.publicId),
  };
};
