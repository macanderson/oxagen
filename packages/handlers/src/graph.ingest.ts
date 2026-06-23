import { z } from "zod";
import { generateObjectFor } from "@oxagen/ai";
import type { CapabilityContext, CapabilityHandler } from "@oxagen/oxagen";
import { graphIngest } from "@oxagen/oxagen/contracts/graph.ingest";
import type { GraphIngestOutput } from "@oxagen/oxagen/contracts/graph.ingest";
import { GRAPH_EDGE_TYPES } from "@oxagen/oxagen/contracts/graph.edge.upsert";
import { invoke } from "@oxagen/oxagen/kernel";
import { logger } from "./logger";
import {
  resolveIngestVocabulary,
  renderVocabularyPrompt,
  strictAllowedLabels,
  type IngestVocabulary,
} from "./graph.ingest-vocabulary";

// A node property value is a scalar drawn from the source text.
const propertyScalar = z.union([z.string(), z.number(), z.boolean()]);

// Properties are extracted as an ARRAY of {key, value} pairs, NOT an open
// z.record. The AI SDK turns z.record into an `additionalProperties`-only JSON
// schema with no named keys, and models reliably return it EMPTY — which is
// exactly why ingested nodes had no domain properties. A named-field pair object
// is something the model fills consistently; we fold it back into a map in code.
const propertyPair = z.object({
  key: z.string().describe("snake_case attribute name, e.g. hull_number"),
  value: propertyScalar.describe("the attribute value, exactly as stated in the text"),
});

// The LLM extraction shape. Confidence is clamped to [0,1]; edge types are
// constrained to the graph's declared relationship vocabulary so the model
// cannot invent edge types the graph.edge.upsert contract would reject. Each
// entity carries `properties`: the concrete, typed attributes the text states
// about it (dates, identifiers, quantities, statuses) — without this the graph
// stores only a bare label + confidence and is useless for retrieval.
const extractionSchema = z.object({
  entities: z
    .array(
      z.object({
        name: z.string(),
        type: z.string(),
        description: z.string().optional(),
        confidence: z.number().min(0).max(1),
        properties: z
          .array(propertyPair)
          .default([])
          .describe("Every concrete attribute the text states about this entity, as key/value pairs"),
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
  vocab: IngestVocabulary;
  maxEntities: number;
  ctx: CapabilityContext;
}): Promise<GraphExtraction> {
  const { text, typeHints, workspacePrompt, vocab, maxEntities, ctx } = args;
  const vocabularyPrompt = renderVocabularyPrompt(vocab);
  const prompt = [
    `Extract entities and relationships from the SOURCE TEXT to grow a knowledge graph.`,
    `Follow these rules (from the workspace's knowledge-graph skills):`,
    `- Read the VOCABULARY and graph guidance below FIRST to decide which entity/edge types matter.`,
    `- Extract with RESTRAINT: only admit entities and relationships the text actually states.`,
    `- Do NOT invent endpoints or infer relationships from mere co-occurrence.`,
    `- For EACH entity, fill "properties" — an array of {key, value} pairs — with every concrete`,
    `  attribute the text states about it (identifiers, dates, quantities, statuses, roles). Reuse a`,
    `  type's listed property keys VERBATIM (snake_case, e.g. hull_number not hullNumber). Values`,
    `  must be scalars taken from the text — never invent a value, omit the pair if not stated.`,
    `- Give each entity and relationship a confidence in [0,1].`,
    `- Use ONLY these edge types: ${GRAPH_EDGE_TYPES.join(", ")}.`,
    `- Produce at most ${maxEntities} entities.`,
    vocabularyPrompt ? `\n${vocabularyPrompt}` : "",
    typeHints.length > 0 ? `\nADDITIONAL ENTITY TYPES TO LOOK FOR: ${typeHints.join(", ")}` : "",
    workspacePrompt ? `\nWORKSPACE GRAPH GUIDANCE:\n${workspacePrompt}` : "",
    `\nSOURCE TEXT:\n${text.slice(0, 100_000)}`,
    `\nReturn JSON { entities: [{name, type, description?, confidence, properties: [{key, value}]}], relationships: [{fromName, toName, edgeType, confidence}] }.`,
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
  return {
    entities: (object.entities ?? []).map((e) => ({ ...e, properties: e.properties ?? [] })),
    relationships: object.relationships ?? [],
  };
}

/** Fold the extracted [{key, value}] pairs into a plain record (last write wins). */
type PropertyPair = { key: string; value: string | number | boolean };

export function propertyPairsToRecord(
  pairs: ReadonlyArray<PropertyPair> | undefined,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  // Array.isArray widens to `any[]`; re-narrow so member access stays typed. The
  // guard still defends against a model returning a non-array at runtime.
  if (!Array.isArray(pairs)) return out;
  for (const p of pairs as ReadonlyArray<PropertyPair>) {
    if (p && typeof p.key === "string") out[p.key] = p.value;
  }
  return out;
}

/**
 * Keep only scalar property values and strip the reserved provenance keys
 * (confidence/source) — those are set authoritatively by the handler, so the
 * model must not be able to overwrite them. Caps the count defensively.
 */
export function sanitizeProperties(
  props: Record<string, string | number | boolean> | undefined,
): Record<string, string | number | boolean> {
  if (!props) return {};
  const out: Record<string, string | number | boolean> = {};
  let n = 0;
  for (const [k, v] of Object.entries(props)) {
    if (k === "confidence" || k === "source") continue;
    if (k.trim().length === 0) continue;
    const t = typeof v;
    if (t !== "string" && t !== "number" && t !== "boolean") continue;
    if (t === "string" && (v as string).trim().length === 0) continue;
    out[k] = v;
    if (++n >= 50) break;
  }
  return out;
}

export const graphIngestHandler: CapabilityHandler<typeof graphIngest> = async (
  input,
  ctx,
) => {
  const workspacePrompt = await readWorkspacePrompt(ctx);
  // Ground extraction in the workspace's configured schema registry (when pinned)
  // and the labels already in its graph, so the model reuses real types/keys
  // instead of inventing inconsistent labels and empty nodes.
  const vocab = await resolveIngestVocabulary(ctx);
  const extraction = await extractGraph({
    text: input.text,
    typeHints: input.entityTypeHints ?? [],
    workspacePrompt,
    vocab,
    maxEntities: input.maxEntities,
    ctx,
  });

  // Strict enforcement: a pinned registry in "strict" mode rejects any entity
  // whose label is not in the configured vocabulary (null when not strict).
  const allowed = strictAllowedLabels(vocab);
  let droppedOffVocabulary = 0;

  // ── Upsert entities (idempotent MERGE = entity resolution) ──────────────────
  const nodeByName = new Map<string, string>();
  const entities: GraphIngestOutput["entities"] = [];
  for (const e of extraction.entities.slice(0, input.maxEntities)) {
    if (e.name.trim().length === 0) continue;
    if (allowed && !allowed.has(sanitizeLabel(e.type).toLowerCase())) {
      droppedOffVocabulary++;
      continue;
    }
    try {
      const out = (await invoke(
        "graph.node.upsert",
        {
          label: sanitizeLabel(e.type),
          displayName: e.name,
          ...(e.description ? { description: e.description } : {}),
          properties: {
            // Domain attributes the model extracted from the text, then the
            // authoritative provenance keys (which win over any model-supplied
            // confidence/source — those are stripped by sanitizeProperties).
            ...sanitizeProperties(propertyPairsToRecord(e.properties)),
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
    {
      entities: entities.length,
      relationships: relationships.length,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      vocabularySource: vocab.source,
      vocabularyLabels: vocab.labels.length,
      enforcement: vocab.enforcement,
      droppedOffVocabulary,
    },
    "graph.ingest completed",
  );

  return { entities, relationships, summary };
};
