import { createFunction } from "../create-function";
import { withTenantDb } from "@oxagen/database";
import { sql } from "drizzle-orm";
import { recordGeneratedFileInGraph } from "@oxagen/ontology";
import { runInTenantScope } from "@oxagen/tenancy";
import { logger } from "../logger";

/**
 * Async mirror of a generated file (content.generated_assets row) into the Neo4j
 * knowledge graph as a searchable :GeneratedFile node + lineage edge to the
 * producing agent execution.
 *
 * Triggered by `content/generated-asset.sync` after persistGeneratedAsset commits
 * the Postgres row. Idempotent — MERGE semantics mean re-runs never duplicate
 * nodes. On success, stamps `synced_to_graph_at` on the row.
 *
 * Retry strategy mirrors agent.sync-execution-to-graph: up to 17 retries over
 * ~24h; on exhaustion `synced_to_graph_at` stays NULL for a nightly sweep.
 */
export const [contentSyncGeneratedFileToGraph] = createFunction(
  {
    id: "content.sync-generated-file-to-graph",
    retries: 17,
    concurrency: { limit: 4, key: "event.data.orgId" },
  },
  { event: "content/generated-asset.sync" },
  async ({ event, step }) => {
    const {
      assetId,
      publicId,
      orgId,
      workspaceId,
      kind,
      mimeType,
      model,
      displayName,
      prompt,
      conversationId,
      messageId,
      summary,
      embedding,
    } = event.data as {
      assetId: string;
      publicId: string;
      orgId: string;
      workspaceId: string;
      kind: string;
      mimeType: string;
      model: string;
      displayName: string;
      prompt?: string | null;
      conversationId?: string | null;
      messageId?: string | null;
      summary?: string | null;
      embedding?: number[] | null;
    };

    await step.run("write-neo4j", () =>
      runInTenantScope({ orgId, workspaceId }, () =>
        recordGeneratedFileInGraph({
          publicId,
          orgId,
          workspaceId,
          kind,
          mimeType,
          model,
          displayName,
          prompt,
          conversationId,
          messageId,
          summary,
          embedding,
        }),
      ),
    );

    // Mark the Postgres row as synced. Parameterized SQL so this function does
    // not hard-depend on the Drizzle schema export shape.
    await step.run("stamp-synced-at", () =>
      runInTenantScope({ orgId, workspaceId }, () =>
        withTenantDb((tx) =>
          tx.execute(
            sql`UPDATE content.generated_assets
                SET synced_to_graph_at = NOW()
                WHERE id = ${assetId}::uuid
                  AND org_id = ${orgId}::uuid`,
          ),
        ),
      ),
    );

    logger.info({ publicId, orgId }, "content.sync-generated-file-to-graph: synced");
    return { publicId, synced: true };
  },
);
