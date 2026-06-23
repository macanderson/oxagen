import type { CapabilityHandler } from "@oxagen/oxagen";
import { connectionMappingsSet } from "@oxagen/oxagen/contracts/connection.mappings.set";
import { schema, withTenantDb } from "@oxagen/database";
import { eq, and, inArray } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { eventClient } from "./event-client";
import { logger } from "./logger";

type Mapping = {
  sourceRecordType: string;
  oxagenEntityType: string;
  propertyMappings: Record<string, string>;
};

// Default entity-type mappings for every GitHub record type the connector can
// normalize. The connect wizard only confirms `repository`, so without these the
// ingestion pipeline finds no mapping for pull_request/issue/release/commit and
// SILENTLY SKIPS them (ingestion.pipeline.ts) — the graph then only ever gets the
// repo node. `propertyMappings: {}` is intentional: the pipeline applies these as
// renames OVER the connector's already-normalized properties, so an empty map
// passes the connector's normalized fields through unchanged. User-supplied
// mappings for the same record type always win.
const DEFAULT_GITHUB_MAPPINGS: readonly Mapping[] = [
  { sourceRecordType: "repository", oxagenEntityType: "source_repository", propertyMappings: {} },
  { sourceRecordType: "pull_request", oxagenEntityType: "pull_request", propertyMappings: {} },
  { sourceRecordType: "issue", oxagenEntityType: "issue", propertyMappings: {} },
  { sourceRecordType: "release", oxagenEntityType: "release", propertyMappings: {} },
  { sourceRecordType: "commit", oxagenEntityType: "commit", propertyMappings: {} },
];

/** Parse "owner/repo" full names into {owner, repo}, dropping malformed entries. */
function parseRepos(fullNames: readonly string[] | undefined): Array<{ owner: string; repo: string }> {
  const out: Array<{ owner: string; repo: string }> = [];
  for (const full of fullNames ?? []) {
    const slash = full.indexOf("/");
    if (slash <= 0 || slash === full.length - 1) continue;
    out.push({ owner: full.slice(0, slash), repo: full.slice(slash + 1) });
  }
  return out;
}

export const connectionMappingsSetHandler: CapabilityHandler<typeof connectionMappingsSet> = async (
  input,
  ctx,
) => {
  // Verify connection exists and belongs to this org/workspace
  const [conn] = await withTenantDb((tx) =>
    tx
      .select({
        id: schema.sourceConnections.id,
        status: schema.sourceConnections.status,
        connectorId: schema.sourceConnections.connectorId,
        deliveryConfig: schema.sourceConnections.deliveryConfig,
      })
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

  const now = new Date();

  // "connected" is the live state in the source_connections_status_check
  // constraint (pending_setup | connected | paused | error) — "active" is not
  // a valid value and would fail the CHECK on write.
  const willActivate = input.activateConnection && conn.status === "pending_setup";
  const isGithub = conn.connectorId === "github";

  // Seed default mappings for every GitHub record type the connector emits, so
  // the ingestion pipeline never silently skips pull_request/issue/release/commit
  // for lack of a mapping. User-supplied mappings take precedence per record type.
  const userTypes = new Set(input.mappings.map((m) => m.sourceRecordType));
  const mappingsToWrite: Mapping[] = isGithub
    ? [...input.mappings, ...DEFAULT_GITHUB_MAPPINGS.filter((m) => !userTypes.has(m.sourceRecordType))]
    : input.mappings;

  // Merge the GitHub source-selection into deliveryConfig so the initial sync can
  // resolve which repos to sync (previously dropped → empty owner/repo → 404).
  const mergedDeliveryConfig =
    input.selectedRepos !== undefined || input.installationId !== undefined || input.syncDepthDays !== undefined
      ? {
          ...((conn.deliveryConfig as Record<string, unknown> | null) ?? {}),
          ...(input.selectedRepos !== undefined ? { selectedRepos: input.selectedRepos } : {}),
          ...(input.installationId !== undefined ? { installationId: input.installationId } : {}),
          ...(input.syncDepthDays !== undefined ? { syncDepthDays: input.syncDepthDays } : {}),
        }
      : undefined;

  // Upsert every mapping AND (optionally) the connection status flip inside a
  // single tenant-scoped transaction. This is atomic — a mid-batch failure
  // rolls back every write — and collapses the previous O(N) round-trips
  // (one SELECT + one INSERT/UPDATE per mapping) into a fixed two-query batch.
  const { created, updated } = await withTenantDb(async (tx) => {
    // One batched lookup of all existing mappings for this connection that
    // collide with the incoming source record types, instead of one SELECT
    // per mapping.
    const sourceTypes = mappingsToWrite.map((m) => m.sourceRecordType);
    const existingRows = sourceTypes.length
      ? await tx
          .select({
            id: schema.entityTypeMappings.id,
            sourceRecordType: schema.entityTypeMappings.sourceRecordType,
          })
          .from(schema.entityTypeMappings)
          .where(
            and(
              eq(schema.entityTypeMappings.connectionId, conn.id),
              inArray(schema.entityTypeMappings.sourceRecordType, sourceTypes),
            ),
          )
      : [];

    const existingByType = new Map(existingRows.map((r) => [r.sourceRecordType, r.id]));

    let createdCount = 0;
    let updatedCount = 0;

    for (const mapping of mappingsToWrite) {
      const existingId = existingByType.get(mapping.sourceRecordType);
      if (existingId) {
        await tx
          .update(schema.entityTypeMappings)
          .set({
            oxagenEntityType: mapping.oxagenEntityType,
            propertyMappings: mapping.propertyMappings,
            isActive: true,
            updatedAt: now,
          })
          .where(eq(schema.entityTypeMappings.id, existingId));
        updatedCount++;
      } else {
        const publicId = `etm_${Date.now().toString(36)}_${mapping.sourceRecordType}`;
        await tx.insert(schema.entityTypeMappings).values({
          publicId,
          connectionId: conn.id,
          workspaceId: ctx.workspaceId,
          orgId: ctx.orgId,
          sourceRecordType: mapping.sourceRecordType,
          oxagenEntityType: mapping.oxagenEntityType,
          propertyMappings: mapping.propertyMappings,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        });
        createdCount++;
      }
    }

    // Persist the GitHub source-selection into deliveryConfig (independent of
    // activation) so the sync can resolve which repos to pull.
    if (mergedDeliveryConfig) {
      await tx
        .update(schema.sourceConnections)
        .set({ deliveryConfig: mergedDeliveryConfig, updatedAt: now })
        .where(eq(schema.sourceConnections.id, conn.id));
    }

    // Activate the connection if requested and currently in pending_setup —
    // in the same transaction so mappings + status flip commit together.
    if (willActivate) {
      await tx
        .update(schema.sourceConnections)
        .set({ status: "connected", updatedAt: now })
        .where(eq(schema.sourceConnections.id, conn.id));
    }

    return { created: createdCount, updated: updatedCount };
  });

  let connectionStatus = conn.status;
  if (willActivate) {
    connectionStatus = "connected";

    // Fire the GitHub initial-sync Inngest event when activating a GitHub
    // connection — after the transaction commits, never inside it. One sync is
    // queued per selected repo; the sync resolves the repo's real default branch
    // itself, so no defaultBranch is passed here.
    if (isGithub) {
      const dc = (mergedDeliveryConfig ?? conn.deliveryConfig) as Record<string, unknown> | null;

      let repos = parseRepos(input.selectedRepos);
      if (repos.length === 0) {
        // Legacy single-repo connections recorded owner/repo directly.
        const owner = typeof dc?.["owner"] === "string" ? (dc["owner"] as string) : "";
        const repo = typeof dc?.["repo"] === "string" ? (dc["repo"] as string) : "";
        if (owner && repo) repos = [{ owner, repo }];
      }

      const syncDepthDays =
        input.syncDepthDays ??
        (typeof dc?.["syncDepthDays"] === "number" ? (dc["syncDepthDays"] as number) : 90);

      if (repos.length === 0) {
        logger.warn(
          { connectionId: conn.id, orgId: ctx.orgId },
          "connection.mappings.set: GitHub connection activated with no repos selected — no sync queued",
        );
      }

      for (const { owner, repo } of repos) {
        await eventClient.send({
          name: "ingestion/github.initial-sync",
          data: {
            connectionId: conn.id,
            orgId: ctx.orgId,
            workspaceId: ctx.workspaceId,
            owner,
            repo,
            syncDepthDays,
          },
        });
      }

      logger.info(
        { connectionId: conn.id, repoCount: repos.length, orgId: ctx.orgId },
        "connection.mappings.set: queued ingestion/github.initial-sync per repo",
      );
    }
  }

  logger.info(
    {
      connectionId: conn.id,
      created,
      updated,
      connectionStatus,
      orgId: ctx.orgId,
    },
    "connection.mappings.set: saved mappings",
  );

  return { mappingsCreated: created, mappingsUpdated: updated, connectionStatus };
};
