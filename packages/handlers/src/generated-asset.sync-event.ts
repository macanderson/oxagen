import { eventClient } from "./event-client";
import { logger } from "./logger";

/**
 * Emitter for `agent/generated-asset.sync` — mirror a generated asset into the
 * Neo4j knowledge graph as a Document node.
 *
 * Called from persistGeneratedAsset() after the Postgres row is committed.
 * Best-effort: the Postgres row is the source of truth. A failure to enqueue
 * is logged, never thrown — syncedToGraphAt simply stays NULL for a sweep to
 * retry, exactly as the worker documents.
 */

export interface GeneratedAssetSyncInput {
  assetId: string;
  publicId: string;
  orgId: string;
  workspaceId: string;
  kind: string;
  mimeType: string;
  prompt: string;
  model: string;
  displayName?: string | null;
  conversationId?: string | null;
  messageId?: string | null;
  userId: string;
}

export async function emitGeneratedAssetSyncEvent(input: GeneratedAssetSyncInput): Promise<void> {
  try {
    await eventClient.send({
      name: "agent/generated-asset.sync",
      data: {
        assetId: input.assetId,
        publicId: input.publicId,
        orgId: input.orgId,
        workspaceId: input.workspaceId,
        kind: input.kind,
        mimeType: input.mimeType,
        prompt: input.prompt,
        model: input.model,
        displayName: input.displayName ?? null,
        conversationId: input.conversationId ?? null,
        messageId: input.messageId ?? null,
        userId: input.userId,
      },
    });
  } catch (err) {
    logger.warn(
      { err, assetId: input.assetId, orgId: input.orgId },
      "generated-asset: failed to enqueue knowledge-graph sync",
    );
  }
}
