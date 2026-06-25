import { createFunction } from "../create-function";
import { withSystemDb, schema } from "@oxagen/database";
import { sql, eq } from "drizzle-orm";
import { recordGeneratedAssetInGraph } from "@oxagen/ontology";
import { runInTenantScope } from "@oxagen/tenancy";
import { logger } from "../logger";

/**
 * Async mirror of a generated asset into the Neo4j knowledge graph as a
 * Document node linked to the originating Conversation via a PRODUCED edge.
 *
 * Triggered by `agent/generated-asset.sync` after persistGeneratedAsset()
 * commits the Postgres row. Idempotent — MERGE semantics mean re-runs never
 * duplicate nodes. On success, stamps `synced_to_graph_at` so the Postgres row
 * carries the audit flag.
 *
 * Retry strategy: Inngest retries up to 17 times over ~24 h (default
 * exponential backoff). After exhaustion the function fails permanently and
 * `synced_to_graph_at` stays NULL — a nightly sweep can catch those.
 */
export const [agentSyncGeneratedAssetToGraph] = createFunction(
  {
    id: "agent.sync-generated-asset-to-graph",
    retries: 17,
    // Limit concurrency per org so a burst doesn't saturate the AuraDB connection pool.
    concurrency: { limit: 4, key: "event.data.orgId" },
  },
  { event: "agent/generated-asset.sync" },
  async ({ event, step }) => {
    const {
      assetId,
      publicId,
      orgId,
      workspaceId,
      kind,
      mimeType,
      prompt,
      model,
      displayName,
      conversationId,
      messageId,
      userId,
    } = event.data as {
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
    };

    await step.run("write-neo4j", () =>
      runInTenantScope({ orgId, workspaceId }, () =>
        recordGeneratedAssetInGraph({
          assetId,
          publicId,
          orgId,
          workspaceId,
          kind,
          mimeType,
          prompt,
          model,
          displayName,
          conversationId,
          messageId,
          userId,
        }),
      ),
    );

    // Stamp the Postgres row as synced.
    await step.run("stamp-synced-at", () =>
      withSystemDb((tx) =>
        tx
          .update(schema.generatedAssets)
          .set({ syncedToGraphAt: sql`NOW()` })
          .where(eq(schema.generatedAssets.id, assetId)),
      ),
    );

    logger.info({ assetId, orgId }, "agent.sync-generated-asset-to-graph: synced");
    return { assetId, synced: true };
  },
);
