import { scopedSession } from "../tenant";
import { NodeLabels, EdgeTypes } from "../types";

export interface RecordGeneratedAssetInput {
  /** The generated_assets.id from Postgres. */
  assetId: string;
  /** The generated_assets.public_id (e.g. "gen_…"). */
  publicId: string;
  orgId: string;
  workspaceId: string;
  /** Asset kind (image, video, document, spreadsheet, presentation, pdf, archive). */
  kind: string;
  /** MIME type (e.g. "image/png", "application/pdf"). */
  mimeType: string;
  /** The generation prompt (stored as a property on the Document node). */
  prompt: string;
  /** The model that generated the asset. */
  model: string;
  /** Optional human-readable display name. */
  displayName?: string | null;
  /** The conversation that triggered the generation (nullable). */
  conversationId?: string | null;
  /** The message that triggered the generation (nullable). */
  messageId?: string | null;
  /** The userId who generated the asset. */
  userId: string;
}

/**
 * Merge a Document node representing a generated asset into the Neo4j knowledge
 * graph and link it to the originating Conversation (if available) via a
 * PRODUCED edge from the Conversation node.
 *
 * Uses MERGE semantics so re-driving the same assetId is idempotent.
 * Tenant-scoped via scopedSession() — orgId is injected automatically.
 */
export async function recordGeneratedAssetInGraph(input: RecordGeneratedAssetInput): Promise<void> {
  const {
    assetId,
    publicId,
    kind,
    mimeType,
    prompt,
    model,
    displayName,
    conversationId,
    messageId,
    userId,
  } = input;

  const neo4j = scopedSession();
  try {
    // Upsert the Document node representing this generated asset.
    await neo4j.run(
      `MERGE (d:${NodeLabels.Document} {id: $assetId, orgId: $orgId})
       ON CREATE SET
         d.publicId      = $publicId,
         d.workspaceId   = $workspaceId,
         d.kind          = $kind,
         d.mimeType      = $mimeType,
         d.prompt        = $prompt,
         d.model         = $model,
         d.displayName   = $displayName,
         d.sourceType    = 'generated_asset',
         d.userId        = $userId,
         d.createdAt     = datetime()
       ON MATCH SET
         d.displayName   = $displayName,
         d.updatedAt     = datetime()`,
      {
        assetId,
        publicId,
        kind,
        mimeType,
        prompt: prompt.slice(0, 2000), // Truncate long prompts for graph storage.
        model,
        displayName: displayName ?? null,
        userId,
      },
    );

    // Link Document → User who generated it (AUTHORED_BY).
    await neo4j.run(
      `MATCH (d:${NodeLabels.Document} {id: $assetId, orgId: $orgId})
       MERGE (u:${NodeLabels.User} {id: $userId, orgId: $orgId})
       MERGE (d)-[:${EdgeTypes.AUTHORED_BY}]->(u)`,
      { assetId, userId },
    );

    // Link Conversation -[PRODUCED]-> Document when a conversation origin exists.
    if (conversationId) {
      await neo4j.run(
        `MATCH (d:${NodeLabels.Document} {id: $assetId, orgId: $orgId})
         MERGE (c:${NodeLabels.Conversation} {id: $conversationId, orgId: $orgId})
         MERGE (c)-[:${EdgeTypes.PRODUCED}]->(d)`,
        { assetId, conversationId },
      );
    }

    // Link Message → Document when a message origin exists (more granular provenance).
    if (messageId) {
      await neo4j.run(
        `MATCH (d:${NodeLabels.Document} {id: $assetId, orgId: $orgId})
         MERGE (m:${NodeLabels.Message} {id: $messageId, orgId: $orgId})
         MERGE (m)-[:${EdgeTypes.PRODUCED}]->(d)`,
        { assetId, messageId },
      );
    }
  } finally {
    await neo4j.close();
  }
}
