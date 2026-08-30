/**
 * schema.recommend — AI-powered schema proposal.
 *
 * Note: For v1 we use graph.stats (node/rel counts + type distribution) as the
 * graph signal. Reading raw `graph_observed_labels` from ClickHouse is deferred
 * to a future iteration (graph.stats is sufficient for initial onboarding).
 */
import type { CapabilityHandler } from "@oxagen/oxagen";
import { schemaRecommend } from "@oxagen/oxagen/contracts/schema.recommend";
import { invoke } from "@oxagen/oxagen/kernel";
import { generateObjectFor } from "@oxagen/ai";
import { z } from "zod";
import { logger } from "./logger";

const proposalSchema = z.object({
  schemas: z.array(
    z.object({
      name: z.string(),
      displayName: z.string(),
      labels: z.array(
        z.object({
          name: z.string(),
          description: z.string().optional(),
          properties: z
            .array(
              z.object({
                key: z.string(),
                dataType: z.enum([
                  "string",
                  "number",
                  "integer",
                  "boolean",
                  "date",
                  "datetime",
                  "url",
                  "email",
                  "enum",
                  "json",
                  "array",
                ]),
                required: z.boolean(),
                description: z.string().optional(),
              }),
            )
            .optional(),
        }),
      ),
      relationshipTypes: z.array(
        z.object({
          name: z.string(),
          startLabel: z.string().optional(),
          endLabel: z.string().optional(),
          description: z.string().optional(),
        }),
      ),
    }),
  ),
});

export const schemaRecommendHandler: CapabilityHandler<
  typeof schemaRecommend
> = async (input, ctx) => {
  const sampleLimit = input.sampleLimit ?? 200;

  // Read graph stats for context. graph.stats's contract only exposes the
  // api/mcp/agent surfaces, but the caller's surface can be "app" or "runner"
  // (e.g. the in-app onboarding proxy) — passing those straight through made the
  // kernel reject this nested invoke, and the swallowed error degraded every
  // recommendation to a generic, graph-blind proposal. This is an internal read,
  // so always invoke it over "api" (a surface graph.stats always supports); the
  // tenant scope rides on `ctx`, independent of this surface gate.
  let graphStats: Record<string, unknown> = {};
  try {
    graphStats = (await invoke(
      "get_graph_stats",
      { includeByType: true },
      ctx,
      {
        surface: "api",
      },
    )) as Record<string, unknown>;
  } catch (err) {
    logger.warn(
      {
        workspaceId: ctx.workspaceId,
        err: err instanceof Error ? err.message : String(err),
      },
      "schema.recommend: graph.stats unavailable",
    );
  }

  const nodeCount = (graphStats.nodeCount as number | undefined) ?? 0;
  const relCount = (graphStats.edgeCount as number | undefined) ?? 0;
  const byType = graphStats.nodesByLabel as Record<string, number> | undefined;
  const topTypes =
    byType && Object.keys(byType).length > 0
      ? Object.entries(byType)
          .sort((a, b) => b[1] - a[1])
          .slice(0, sampleLimit)
          .map(([t, c]) => `${t}: ${c}`)
          .join(", ")
      : "no type data available";

  const prompt = `You are a knowledge graph schema expert. Based on the following graph statistics, propose a well-structured schema registry for this workspace.

Graph context:
- Total nodes: ${nodeCount}
- Total relationships: ${relCount}
- Observed node types (up to ${sampleLimit} most common): ${topTypes}

Please propose 1-3 schemas with appropriate node labels, relationship types, and key properties. Each schema should group logically related entities. Focus on the most important properties for deduplication and grounding.`;

  const { object } = await generateObjectFor({
    schema: proposalSchema,
    prompt,
    system:
      "You are an expert at designing knowledge graph schemas. Return only well-structured, practical schemas.",
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
      schemaCount: object.schemas.length,
    },
    "schema.recommend: generated proposal",
  );

  return {
    proposal: object,
    rationale: `Analyzed ${nodeCount} nodes and ${relCount} relationships. Top observed types: ${topTypes.slice(0, 200)}.`,
    sampledCount: nodeCount,
  };
};
