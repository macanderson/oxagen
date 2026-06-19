import { z } from "zod";
import { generateObjectFor } from "@oxagen/ai";
import type { CapabilityContext, CapabilityHandler } from "@oxagen/oxagen";
import { graphIngest } from "@oxagen/oxagen/contracts/graph.ingest";
import type { GraphIngestOutput } from "@oxagen/oxagen/contracts/graph.ingest";
import { GRAPH_EDGE_TYPES } from "@oxagen/oxagen/contracts/graph.edge.upsert";
import { invoke } from "@oxagen/oxagen/kernel";
import { logger } from "./logger";

// The LLM extraction shape. Confidence is clamped to [0,1]; edge types are
// constrained to the graph's declared relationship vocabulary so the model
// cannot invent edge types the graph.edge.upsert contract would reject.
const extractionSchema = z.object({
  entities: z
    .array(
      z.object({
        name: z.string(),
        type: z.string(),
        description: z.string().optional(),
        confidence: z.number().min(0).max(1),
      }),
    )
    .default([]),
  relationships: z
    .array(
      z.object({
        fromName: z.string(),
        toName: z.string(),
        edgeType: z.enum(GRAPH_EDGE_TYPES),
        confidence: z.number().min(0).max(1),
      }),
    )
    .default([]),
});

export type GraphExtraction = z.output<typeof extractionSchema>;

/** A graph node label must be a non-empty ≤100-char string (the contract bound). */
export function sanitizeLabel(type: string): string {
  const trimmed = type.trim().slice(0, 100);
  return trimmed.length > 0 ? trimmed : "Entity";
}

async function readWorkspacePrompt(ctx: CapabilityContext): Promise<string> {
  try {
    const out = (await invoke("prompt.settings.read", {}, ctx)) as {
      additionalInstructions?: string | null;
    };
    return out.additionalInstructions ?? "";
  } catch {
    return "";
  }
}

export async function extractGraph(args: {
  text: string;
  typeHints: string[];
  workspacePrompt: string;
  maxEntities: number;
  ctx: CapabilityContext;
}): Promise<GraphExtraction> {
  const { text, typeHints, workspacePrompt, maxEntities, ctx } = args;
  const prompt = [
    `Extract entities and relationships from the SOURCE TEXT to grow a knowledge graph.`,
    `Follow these rules (from the workspace's knowledge-graph skills):`,
    `- Read the graph guidance below FIRST to decide which entity/edge types matter.`,
    `- Extract with RESTRAINT: only admit entities and relationships the text actually states.`,
    `- Do NOT invent endpoints or infer relationships from mere co-occurrence.`,
    `- Give each entity and relationship a confidence in [0,1].`,
    `- Use ONLY these edge types: ${GRAPH_EDGE_TYPES.join(", ")}.`,
    `- Produce at most ${maxEntities} entities.`,
    typeHints.length > 0 ? `\nENTITY TYPES TO LOOK FOR: ${typeHints.join(", ")}` : "",
    workspacePrompt ? `\nWORKSPACE GRAPH GUIDANCE:\n${workspacePrompt}` : "",
    `\nSOURCE TEXT:\n${text.slice(0, 100_000)}`,
    `\nReturn JSON { entities: [{name, type, description?, confidence}], relationships: [{fromName, toName, edgeType, confidence}] }.`,
  ]
    .filter(Boolean)
    .join("\n");

  const { object } = await generateObjectFor({
    schema: extractionSchema,
    prompt,
    telemetry: {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      surface: ctx.surface,
      messageId: ctx.messageId ?? ctx.requestId,
    },
  });
  // The schema's .default([]) leaves the arrays optional in the inferred input
  // type; normalize to the concrete output shape.
  return { entities: object.entities ?? [], relationships: object.relationships ?? [] };
}

export const graphIngestHandler: CapabilityHandler<typeof graphIngest> = async (
  input,
  ctx,
) => {
  const workspacePrompt = await readWorkspacePrompt(ctx);
  const extraction = await extractGraph({
    text: input.text,
    typeHints: input.entityTypeHints ?? [],
    workspacePrompt,
    maxEntities: input.maxEntities,
    ctx,
  });

  // ── Upsert entities (idempotent MERGE = entity resolution) ──────────────────
  const nodeByName = new Map<string, string>();
  const entities: GraphIngestOutput["entities"] = [];
  for (const e of extraction.entities.slice(0, input.maxEntities)) {
    if (e.name.trim().length === 0) continue;
    try {
      const out = (await invoke(
        "graph.node.upsert",
        {
          label: sanitizeLabel(e.type),
          displayName: e.name,
          ...(e.description ? { description: e.description } : {}),
          properties: {
            confidence: e.confidence,
            ...(input.sourceUrl ? { source: input.sourceUrl } : {}),
          },
        },
        ctx,
        { surface: "agent" },
      )) as { nodeId: string; created: boolean };
      nodeByName.set(e.name.toLowerCase(), out.nodeId);
      entities.push({
        nodeId: out.nodeId,
        name: e.name,
        type: sanitizeLabel(e.type),
        confidence: e.confidence,
        created: out.created,
      });
    } catch (err) {
      logger.warn({ err, name: e.name }, "graph.ingest: entity upsert failed");
    }
  }

  // ── Upsert relationships — both endpoints must resolve to a node ────────────
  const relationships: GraphIngestOutput["relationships"] = [];
  for (const r of extraction.relationships) {
    const fromId = nodeByName.get(r.fromName.toLowerCase());
    const toId = nodeByName.get(r.toName.toLowerCase());
    if (!fromId || !toId) continue; // skill discipline: no invented endpoints
    try {
      const out = (await invoke(
        "graph.edge.upsert",
        {
          fromNodeId: fromId,
          toNodeId: toId,
          edgeType: r.edgeType,
          properties: { confidence: String(r.confidence) },
        },
        ctx,
        { surface: "agent" },
      )) as { edgeId: string; created: boolean };
      relationships.push({
        edgeId: out.edgeId,
        from: r.fromName,
        to: r.toName,
        edgeType: r.edgeType,
        confidence: r.confidence,
        created: out.created,
      });
    } catch (err) {
      logger.warn({ err, from: r.fromName, to: r.toName }, "graph.ingest: edge upsert failed");
    }
  }

  const summary =
    `Ingested ${entities.length} entit${entities.length === 1 ? "y" : "ies"} and ` +
    `${relationships.length} relationship${relationships.length === 1 ? "" : "s"} into the ` +
    `knowledge graph.`;

  logger.info(
    { entities: entities.length, relationships: relationships.length, orgId: ctx.orgId },
    "graph.ingest completed",
  );

  return { entities, relationships, summary };
};
