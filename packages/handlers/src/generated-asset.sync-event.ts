import { embedText } from "@oxagen/ai";
import { eventClient } from "./event-client";
import { logger } from "./logger";

/**
 * Shared emitter for `content/generated-asset.sync` — mirror a generated file
 * (content.generated_assets row) into the Neo4j knowledge graph as a searchable
 * :GeneratedFile node with an embedding and a lineage edge to the agent
 * execution that produced it.
 *
 * Called from the single persistence chokepoint (generated-asset.persist) after
 * the Postgres row commits, so every generator (markdown/image/documents/pdf/
 * archive/video) is mirrored without per-handler plumbing. The async worker
 * (content.sync-generated-file-to-graph) consumes the event and MERGEs the node.
 *
 * - Best-effort: the Postgres row is the source of truth. A failure to enqueue
 *   is logged, never thrown — synced_to_graph_at simply stays NULL for a sweep.
 * - Embedding: computed here so the Inngest worker need not depend on @oxagen/ai.
 *   A failed embed still emits the event with embedding: null; the node is
 *   written (searchable by traversal) and a nightly sweep can backfill the vector.
 * - executionStepId MUST be null (not a synthesized string) — it flows into the
 *   ClickHouse token_usage UUID column + Postgres credit_ledger.reference_id.
 */

// Cap the embed source text. text-embedding-3-small truncates at ~8k tokens; we
// bound the bytes we read/ship so a huge document doesn't bloat the event.
const MAX_EMBED_CHARS = 8000;

export interface GeneratedFileSyncInput {
  /** Internal UUID of the generated_assets row (for stamping synced_to_graph_at). */
  assetId: string;
  /** User-facing id ("gen_…") — the node publicId. */
  publicId: string;
  orgId: string;
  workspaceId: string;
  kind: string;
  mimeType: string;
  model: string;
  /** Clean human-readable name (e.g. the file's slug/title); never a raw UUID. */
  displayName: string;
  prompt?: string | null;
  conversationId?: string | null;
  messageId?: string | null;
  /** Decoded text content for text/* assets — the strongest embedding source. */
  contentText?: string | null;
}

/** Build the text we embed + store as the node's snippet source. */
function buildEmbedText(input: GeneratedFileSyncInput): string {
  const parts: string[] = [input.displayName];
  const content = (input.contentText ?? "").trim();
  if (content.length > 0) {
    parts.push(content);
  } else if (input.prompt && input.prompt.trim().length > 0) {
    parts.push(input.prompt.trim());
  }
  parts.push(`(${input.kind})`);
  return parts.join("\n").slice(0, MAX_EMBED_CHARS);
}

export async function emitGeneratedFileSyncEvent(input: GeneratedFileSyncInput): Promise<void> {
  const summary = buildEmbedText(input);

  let embedding: number[] | null = null;
  try {
    embedding = await embedText(summary, {
      telemetry: {
        orgId: input.orgId,
        workspaceId: input.workspaceId,
        surface: "runner",
        executionStepId: null,
      },
    });
  } catch (err) {
    logger.warn(
      { err, publicId: input.publicId, orgId: input.orgId },
      "generated-asset: embedding failed — file node will be written without a vector",
    );
  }

  try {
    await eventClient.send({
      name: "content/generated-asset.sync",
      data: {
        assetId: input.assetId,
        publicId: input.publicId,
        orgId: input.orgId,
        workspaceId: input.workspaceId,
        kind: input.kind,
        mimeType: input.mimeType,
        model: input.model,
        displayName: input.displayName,
        prompt: input.prompt ?? null,
        conversationId: input.conversationId ?? null,
        messageId: input.messageId ?? null,
        summary,
        embedding,
      },
    });
  } catch (err) {
    logger.warn(
      { err, publicId: input.publicId, orgId: input.orgId },
      "generated-asset: failed to enqueue knowledge-graph file sync",
    );
  }
}
