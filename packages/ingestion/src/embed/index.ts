/**
 * Stage 4 — Embed entity node.
 *
 * Calls embedText() (packages/ai/src/embed.ts) to generate a 1536-dim vector
 * from the entity's rendered text representation, then stores it on the Neo4j
 * node via upsertEmbedding().
 *
 * Every entity that reaches this stage MUST get an embedding — it is a pipeline
 * invariant. The vector enables semantic search and is required for the alias
 * deduplication Pass B in future ingestions of similar entities.
 */

import { embedText } from "@oxagen/ai";
import { upsertEmbedding } from "../mutations/upsert-entity";
import type { EmbedRequest } from "../types";

/** Embedding model. 1536 dims, matches all existing vector indexes. */
const EMBED_MODEL = "openai/text-embedding-3-small";

/**
 * Build a plain-text representation of an entity for embedding.
 * Implementors should include: displayName, key properties (description, body,
 * title, tags), and a type prefix so embeddings from different entity types
 * don't collide in the vector space.
 *
 * Example:
 *   "github:PullRequest Add OAuth login  author:mac@oxagen.ai  labels:auth,security  body:This PR adds..."
 */
export function renderEntityText(
  entityType: string,
  displayName: string | undefined,
  properties: Record<string, unknown>,
): string {
  const parts: string[] = [`${entityType}`];
  if (displayName) parts.push(displayName);
  for (const [k, v] of Object.entries(properties)) {
    if (v == null) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      parts.push(`${k}:${v}`);
    }
  }
  return parts.join("  ");
}

/**
 * Stage 4 handler. Embeds the entity and writes the vector to Neo4j.
 * Called by the Inngest pipeline function after Stage 3 (dedup).
 */
export async function embedEntity(req: EmbedRequest): Promise<void> {
  const result = await embedText(req.text, {
    model: EMBED_MODEL,
    telemetry: {
      orgId: req.orgId,
      workspaceId: req.workspaceId,
      surface: "ingestion",
      executionStepId: `embed:${req.nodeId}`,
    },
  });
  await upsertEmbedding(req.nodeId, result.embedding, EMBED_MODEL, req.orgId);
}
