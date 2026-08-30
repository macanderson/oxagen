import type { CapabilityHandler } from "@oxagen/oxagen";
import { connectionMappingsSet } from "@oxagen/oxagen/contracts/connection.mappings.set";
import { schema, withTenantDb } from "@oxagen/database";
import { eq, and, inArray } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { eventClient } from "./event-client";
import { logger } from "./logger";
import { assertGithubInstallationAccessible } from "./lib/github-installation-access";
import { getConnector } from "@oxagen/ingestion/connectors";

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
  {
    sourceRecordType: "repository",
    oxagenEntityType: "source_repository",
    propertyMappings: {},
  },
  {
    sourceRecordType: "pull_request",
    oxagenEntityType: "pull_request",
    propertyMappings: {},
  },
  {
    sourceRecordType: "issue",
    oxagenEntityType: "issue",
    propertyMappings: {},
  },
  {
    sourceRecordType: "release",
    oxagenEntityType: "release",
    propertyMappings: {},
  },
  {
    sourceRecordType: "commit",
    oxagenEntityType: "commit",
    propertyMappings: {},
  },
];

/** Parse "owner/repo" full names into {owner, repo}, dropping malformed entries. */
function parseRepos(
  fullNames: readonly string[] | undefined,
): Array<{ owner: string; repo: string }> {
  const out: Array<{ owner: string; repo: string }> = [];
  for (const full of fullNames ?? []) {
    const slash = full.indexOf("/");
    if (slash <= 0 || slash === full.length - 1) continue;
    out.push({ owner: full.slice(0, slash), repo: full.slice(slash + 1) });
  }
  return out;
}

/**
 * A GitHub connection's display name is always the repo slug it's bound to —
 * `organization-slug/repo-slug` — never a free-form label. One connection
 * reads as exactly the repo it ingests, so the Knowledge → Repos tab list
 * can't fill with duplicate-looking generic names.
 * Multi-repo selections show the primary repo plus a `(+N more)` count.
 * Returns undefined when no repo is resolvable (nothing to rename to).
 */
function repoSlugName(
  repos: ReadonlyArray<{ owner: string; repo: string }>,
): string | undefined {
  const [primary, ...rest] = repos;
  if (!primary) return undefined;
  const slug = `${primary.owner}/${primary.repo}`;
  return rest.length > 0 ? `${slug} (+${rest.length} more)` : slug;
}

export const connectionMappingsSetHandler: CapabilityHandler<
  typeof connectionMappingsSet
> = async (input, ctx) => {
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
  const willActivate =
    input.activateConnection && conn.status === "pending_setup";
  const isGithub = conn.connectorId === "github";

  // AUTHORIZATION GATE: binding a GitHub App installation lets the server mint an
  // installation token for it (GITHUB_APP_PRIVATE_KEY is server-held), so a
  // client-supplied installationId MUST be proven reachable by the acting user
  // on GitHub before we trust it — otherwise a workspace could PUT an arbitrary
  // installationId (bypassing the wizard picker) and read a GitHub org's private
  // repos it has no access to. Fail-closed; the OAuth callback is exempt (its id
  // arrives via GitHub's HMAC-verified redirect, not client input).
  if (isGithub && input.installationId !== undefined) {
    await assertGithubInstallationAccessible(ctx, input.installationId);
  }

  // Seed default mappings for every GitHub record type the connector emits, so
  // the ingestion pipeline never silently skips pull_request/issue/release/commit
  // for lack of a mapping. User-supplied mappings take precedence per record type.
  const userTypes = new Set(input.mappings.map((m) => m.sourceRecordType));
  const mappingsToWrite: Mapping[] = isGithub
    ? [
        ...input.mappings,
        ...DEFAULT_GITHUB_MAPPINGS.filter(
          (m) => !userTypes.has(m.sourceRecordType),
        ),
      ]
    : input.mappings;

  // Merge EVERY GitHub source-selection field the caller supplied into
  // deliveryConfig so the initial sync can resolve which repos to pull.
  // Covers both the multi-repo wizard flow (selectedRepos) and a single
  // owner/repo/defaultBranch.
  const dcUpdates: Record<string, unknown> = {};
  if (input.owner !== undefined) dcUpdates["owner"] = input.owner;
  if (input.repo !== undefined) dcUpdates["repo"] = input.repo;
  if (input.defaultBranch !== undefined)
    dcUpdates["defaultBranch"] = input.defaultBranch;
  if (input.installationId !== undefined)
    dcUpdates["installationId"] = input.installationId;
  if (input.syncDepthDays !== undefined)
    dcUpdates["syncDepthDays"] = input.syncDepthDays;
  if (input.selectedRepos !== undefined)
    dcUpdates["selectedRepos"] = input.selectedRepos;

  const mergedDeliveryConfig =
    Object.keys(dcUpdates).length > 0
      ? {
          ...((conn.deliveryConfig as Record<string, unknown> | null) ?? {}),
          ...dcUpdates,
        }
      : undefined;

  // Resolve the repo selection ONCE, up front, so both the auto-rename (below,
  // in the activation UPDATE) and the initial-sync fan-out (after the tx) share
  // the same list — the multi-repo wizard selection, else a single stored or
  // request owner/repo.
  const dcForRepos =
    ((mergedDeliveryConfig ?? conn.deliveryConfig) as Record<
      string,
      unknown
    > | null) ?? {};
  let resolvedRepos = parseRepos(input.selectedRepos);
  if (resolvedRepos.length === 0) {
    const owner =
      input.owner ??
      (typeof dcForRepos["owner"] === "string"
        ? (dcForRepos["owner"] as string)
        : "");
    const repo =
      input.repo ??
      (typeof dcForRepos["repo"] === "string"
        ? (dcForRepos["repo"] as string)
        : "");
    if (owner && repo) resolvedRepos = [{ owner, repo }];
  }

  // A GitHub connection is always named after the repo slug it binds to. Only
  // set it when we actually resolved a repo — never blank out an existing name.
  const autoName = isGithub ? repoSlugName(resolvedRepos) : undefined;

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

    const existingByType = new Map(
      existingRows.map((r) => [r.sourceRecordType, r.id]),
    );

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

    // Persist the merged deliveryConfig and (optionally) flip status — combined
    // into a single UPDATE when both apply so the row is always consistent.
    if (willActivate) {
      await tx
        .update(schema.sourceConnections)
        .set({
          status: "connected",
          ...(mergedDeliveryConfig
            ? { deliveryConfig: mergedDeliveryConfig }
            : {}),
          ...(autoName ? { displayName: autoName } : {}),
          updatedAt: now,
        })
        .where(eq(schema.sourceConnections.id, conn.id));
    } else if (mergedDeliveryConfig || autoName) {
      await tx
        .update(schema.sourceConnections)
        .set({
          ...(mergedDeliveryConfig
            ? { deliveryConfig: mergedDeliveryConfig }
            : {}),
          ...(autoName ? { displayName: autoName } : {}),
          updatedAt: now,
        })
        .where(eq(schema.sourceConnections.id, conn.id));
    }

    return { created: createdCount, updated: updatedCount };
  });

  let connectionStatus = conn.status;
  if (willActivate) {
    connectionStatus = "connected";

    // Fire the GitHub initial-sync Inngest event when activating a GitHub
    // connection — after the transaction commits, never inside it. One sync is
    // queued per selected repo. defaultBranch is passed as a hint; the sync still
    // resolves the repo's real default branch from the GitHub API.
    if (isGithub) {
      const dc = dcForRepos;

      // Repos to sync were resolved up front (shared with the auto-rename).
      const repos = resolvedRepos;

      const defaultBranch =
        input.defaultBranch ??
        (typeof dc["defaultBranch"] === "string"
          ? (dc["defaultBranch"] as string)
          : "main");
      const syncDepthDays =
        input.syncDepthDays ??
        (typeof dc["syncDepthDays"] === "number"
          ? (dc["syncDepthDays"] as number)
          : 90);

      if (repos.length === 0) {
        logger.warn(
          { connectionId: conn.id, orgId: ctx.orgId },
          "connection.mappings.set: GitHub connection activated with no repos selected — no sync queued",
        );
      }

      // One sync per selected repo — the events are independent (no ordering
      // dependency), so fan them out in parallel instead of awaiting serially.
      await Promise.all(
        repos.map(({ owner, repo }) =>
          eventClient.send({
            name: "ingestion/github.initial-sync",
            data: {
              connectionId: conn.id,
              orgId: ctx.orgId,
              workspaceId: ctx.workspaceId,
              owner,
              repo,
              defaultBranch,
              syncDepthDays,
            },
          }),
        ),
      );

      logger.info(
        { connectionId: conn.id, repoCount: repos.length, orgId: ctx.orgId },
        "connection.mappings.set: queued ingestion/github.initial-sync per repo",
      );
    }

    // Provision the provider webhook subscription for webhook-declared
    // connectors (microsoft / google-*) once the connection is active. Without
    // this the delivery route's JOIN finds no secret and every real delivery
    // 401s. Fired after commit; the provision function is idempotent.
    let isWebhookConnector = false;
    try {
      const connector = getConnector(conn.connectorId);
      isWebhookConnector =
        connector.deliveryMethod === "webhook" &&
        typeof connector.subscribeWebhooks === "function";
    } catch {
      isWebhookConnector = false;
    }
    if (isWebhookConnector) {
      await eventClient.send({
        name: "ingestion/webhook.provision",
        data: {
          connectionId: conn.id,
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
        },
      });
      logger.info(
        {
          connectionId: conn.id,
          connectorId: conn.connectorId,
          orgId: ctx.orgId,
        },
        "connection.mappings.set: queued ingestion/webhook.provision",
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

  return {
    mappingsCreated: created,
    mappingsUpdated: updated,
    connectionStatus,
  };
};
