import { and, eq, isNull, sql } from "drizzle-orm";
import {
  MOVABLE_TRANSPORTS,
  steeringWriter,
  type OpenedSteeringPr,
  type ServerFolderWriter,
} from "@oxagen/agent/runtime/steering-pr";
import { schema, withTenantDb } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import { HandlerError, type CapabilityContext } from "@oxagen/oxagen";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { pluginSetEnabled } from "@oxagen/oxagen/contracts/plugin.set_enabled";
import { assertContractRole } from "./lib/capability-role-guard";
import { logger } from "./logger";

/** Map authKind from the installed plugin to the authStrategy expected by connectMcp. */
function mapAuthStrategy(authKind: string): "none" | "bearer" | "header" {
  if (authKind === "none") return "none";
  if (authKind === "oauth") return "bearer";
  // "secret" — use bearer (API key in Authorization header is the most common pattern)
  return "bearer";
}

type Input = {
  scope: "org" | "workspace";
  orgListingId: string;
  enabled: boolean;
};

type Listing = typeof schema.pluginInstalledPlugins.$inferSelect;

/** Audit event for a successful toggle. Fire-and-forget; it must not fail the capability. */
function emitEnabledChanged(ctx: CapabilityContext): void {
  emitSecurityEvent({
    eventType: "plugin.enabled_changed",
    actorUserId: ctx.userId ?? null,
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId ?? null,
    capability: "set_plugin_enabled",
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: ctx.requestId ?? null,
  });
}

/**
 * Enable a plugin in a workspace whose tools live in its steering repo.
 *
 * A plugin whose row the steering repo already holds (origin steering, or a
 * legacy row a migration PR named) is toggled on directly: null is returned
 * and the caller upserts as before. Otherwise the row becomes a proposed,
 * disabled row, and the writer opens a steering PR that adds its server
 * folder. The first publish after that PR merges turns the row on.
 *
 * When the PR does not open, the row goes back to what it was and the error
 * is rethrown.
 */
async function enableThroughSteering(
  writer: ServerFolderWriter,
  listing: Listing,
  ctx: CapabilityContext,
): Promise<{ publicId: string; pr: OpenedSteeringPr } | null> {
  const s = schema.mcpServers;
  // The listing index covers deleted rows too, so the lookup reads them.
  const existing = await withTenantDb(async (tx) => {
    const [row] = await tx
      .select({
        id: s.id,
        publicId: s.publicId,
        origin: s.origin,
        steeringName: s.steeringName,
        enabled: s.enabled,
        deletedAt: s.deletedAt,
        deletedById: s.deletedById,
      })
      .from(s)
      .where(
        and(
          eq(s.orgId, ctx.orgId),
          eq(s.workspaceId, ctx.workspaceId),
          eq(s.orgListingId, listing.id),
        ),
      )
      .limit(1);
    return row ?? null;
  });

  if (existing !== null && existing.deletedAt === null) {
    if (existing.origin === "steering" || (existing.origin === "legacy" && existing.steeringName !== null)) {
      return null;
    }
    if (existing.origin === "proposed" && existing.steeringName !== null) {
      throw new HandlerError({
        code: "conflict",
        reason: "steering_pr_open",
        message: `"${listing.name}" turns on when the steering PR that adds tools/servers/${existing.steeringName}/ merges and publishes.`,
      });
    }
  }

  // The undo only touches a row that is still proposed with no folder name.
  // A concurrent enable that reserved a name keeps its row and its PR.
  const stillUnnamedProposal = (id: string) =>
    and(eq(s.id, id), eq(s.workspaceId, ctx.workspaceId), eq(s.origin, "proposed"), isNull(s.steeringName));

  const enableInProgress = () =>
    new HandlerError({
      code: "conflict",
      reason: "plugin_enable_in_progress",
      message: `Another request is enabling "${listing.name}" in this workspace. Try again in a moment.`,
    });

  let row: { id: string; publicId: string };
  let undo: () => Promise<unknown>;
  if (existing !== null) {
    // The update matches only the origin and folder name this request read.
    // A concurrent enable that already changed the row, or reserved a folder
    // name for it, keeps its PR, and this request stops instead of clearing
    // the name and opening a second PR.
    const [converted] = await withTenantDb((tx) =>
      tx
        .update(s)
        .set({
          origin: "proposed",
          enabled: false,
          steeringName: null,
          deletedAt: null,
          deletedById: null,
          healthStatus: "unknown",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(s.id, existing.id),
            eq(s.workspaceId, ctx.workspaceId),
            eq(s.origin, existing.origin),
            existing.steeringName === null ? isNull(s.steeringName) : eq(s.steeringName, existing.steeringName),
          ),
        )
        .returning({ id: s.id }),
    );
    if (converted === undefined) throw enableInProgress();
    row = { id: existing.id, publicId: existing.publicId };
    undo = () =>
      withTenantDb((tx) =>
        tx
          .update(s)
          .set({
            origin: existing.origin,
            enabled: existing.enabled,
            steeringName: existing.steeringName,
            deletedAt: existing.deletedAt,
            deletedById: existing.deletedById,
            updatedAt: new Date(),
          })
          .where(stillUnnamedProposal(existing.id)),
      );
  } else {
    const [inserted] = await withTenantDb((tx) =>
      tx
        .insert(s)
        .values({
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
          orgListingId: listing.id,
          name: listing.name,
          transportType: listing.transport ?? "sse",
          endpointUrl: listing.endpointUrl!,
          authStrategy: mapAuthStrategy(listing.authKind),
          authConfig: {},
          healthStatus: "unknown",
          enabled: false,
          origin: "proposed",
          discoveredTools: [],
        })
        // onConflictDoNothing names the partial index's predicate `where`, not
        // `targetWhere`, and renders it as ON CONFLICT (...) WHERE ... DO NOTHING.
        .onConflictDoNothing({
          target: [s.workspaceId, s.orgListingId],
          where: sql`org_listing_id IS NOT NULL`,
        })
        .returning({ id: s.id, publicId: s.publicId }),
    );
    if (inserted === undefined) throw enableInProgress();
    row = inserted;
    undo = () =>
      withTenantDb((tx) =>
        tx
          .update(s)
          .set({ deletedAt: new Date(), deletedById: ctx.userId, updatedAt: new Date() })
          .where(stillUnnamedProposal(inserted.id)),
      );
  }

  let pr: OpenedSteeringPr;
  try {
    pr = await writer.addServer({
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      serverId: row.id,
      actorUserId: ctx.userId,
    });
  } catch (err) {
    await undo().catch((undoErr: unknown) => {
      logger.error(
        { err: undoErr, serverId: row.id, orgListingId: listing.id, workspaceId: ctx.workspaceId },
        "set_plugin_enabled(workspace): the steering PR did not open and the proposed row was not rolled back",
      );
    });
    throw err;
  }
  return { publicId: row.publicId, pr };
}

// scope="org": toggle the org listing's enabled flag.
const setOrgEnabled: CapabilityHandlerFn = async (input, ctx) => {
  const { orgListingId, enabled } = input as Input;
  if (!ctx.workspaceId) {
    throw new Error(
      "[set_plugin_enabled] workspaceId is required (scoped capability)",
    );
  }

  try {
    await withTenantDb(async (tx) => {
      await tx
        .update(schema.pluginInstalledPlugins)
        .set({ enabled })
        .where(
          and(
            eq(schema.pluginInstalledPlugins.id, orgListingId),
            eq(schema.pluginInstalledPlugins.orgId, ctx.orgId),
            eq(schema.pluginInstalledPlugins.workspaceId, ctx.workspaceId!),
          ),
        );
    });
  } catch (err) {
    logger.error(
      {
        err,
        orgListingId,
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        enabled,
      },
      "set_plugin_enabled(org): failed",
    );
    throw err;
  }

  emitEnabledChanged(ctx);

  logger.info(
    { orgListingId, orgId: ctx.orgId, workspaceId: ctx.workspaceId, enabled },
    "set_plugin_enabled(org): ok",
  );
  return { ok: true, workspaceServerId: null };
};

// scope="workspace": upsert/disable the workspace's agent.mcp_servers row.
const setWorkspaceEnabled: CapabilityHandlerFn = async (input, ctx) => {
  const { orgListingId, enabled } = input as Input;

  if (!ctx.workspaceId) {
    throw new Error(
      "[set_plugin_enabled] workspaceId is required (scoped capability)",
    );
  }

  // Load the installed plugin row — must belong to this org + workspace.
  const listing = await withTenantDb(async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.pluginInstalledPlugins)
      .where(
        and(
          eq(schema.pluginInstalledPlugins.id, orgListingId),
          eq(schema.pluginInstalledPlugins.orgId, ctx.orgId),
          eq(schema.pluginInstalledPlugins.workspaceId, ctx.workspaceId!),
          isNull(schema.pluginInstalledPlugins.deletedAt),
        ),
      )
      .limit(1);
    return row ?? null;
  });

  if (!listing) {
    throw new Error(
      `[set_plugin_enabled] Installed plugin not found or deleted: ${orgListingId}`,
    );
  }

  // Guard: capability packs cannot be workspace-toggled via mcp_servers — they
  // are invoked internally, not over a network transport.
  if (listing.pluginType === "agent_capability") {
    throw new Error(
      "[set_plugin_enabled] Workspace-level enable/disable for Oxagen Plugins arrives in Phase 2. " +
        "Capability packs are org-level — use scope='org' instead.",
    );
  }

  if (enabled) {
    if (!listing.enabled) {
      throw new Error(
        `[set_plugin_enabled] Installed plugin "${listing.name}" is disabled.`,
      );
    }
    if (!listing.endpointUrl) {
      throw new Error(
        `[set_plugin_enabled] Installed plugin "${listing.name}" has no endpoint URL.`,
      );
    }

    // Once the workspace's tools live in its steering repo, a new server is
    // a steering PR. steeringWriter() is null until then.
    const transportType = listing.transport ?? "sse";
    const movable = (MOVABLE_TRANSPORTS as readonly string[]).includes(transportType);
    const writer = movable
      ? await steeringWriter({ orgId: ctx.orgId, workspaceId: ctx.workspaceId })
      : null;
    if (writer !== null) {
      const proposed = await enableThroughSteering(writer, listing, ctx);
      if (proposed !== null) {
        emitEnabledChanged(ctx);
        logger.info(
          {
            orgListingId,
            orgId: ctx.orgId,
            workspaceId: ctx.workspaceId,
            workspaceServerId: proposed.publicId,
            steeringPr: proposed.pr.number,
          },
          "set_plugin_enabled(workspace): opened a steering PR",
        );
        return {
          ok: true,
          workspaceServerId: proposed.publicId,
          steeringPr: { number: proposed.pr.number, url: proposed.pr.url },
        };
      }
    }

    // Upsert the workspace MCP server row.
    const authStrategy = mapAuthStrategy(listing.authKind);

    const row = await withTenantDb(async (tx) => {
      const [inserted] = await tx
        .insert(schema.mcpServers)
        .values({
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId!,
          orgListingId,
          name: listing.name,
          transportType,
          endpointUrl: listing.endpointUrl!,
          authStrategy,
          authConfig: {},
          healthStatus: "unknown",
          enabled: true,
          discoveredTools: [],
        })
        .onConflictDoUpdate({
          target: [
            schema.mcpServers.workspaceId,
            schema.mcpServers.orgListingId,
          ],
          // mcp_servers_ws_listing_uniq is a PARTIAL unique index; ON CONFLICT
          // only matches it when the inference clause carries the same predicate.
          targetWhere: sql`org_listing_id IS NOT NULL`,
          set: {
            enabled: true,
            healthStatus: "unknown",
            ...(movable
              ? {
                  // A proposal enabled here, while the workspace writes rows
                  // directly, becomes an ordinary legacy row. Left proposed,
                  // the migration would never count it and no publish would
                  // take it over unless a steering PR named it.
                  origin: sql`CASE WHEN ${schema.mcpServers.origin} = 'proposed' THEN 'legacy' ELSE ${schema.mcpServers.origin} END`,
                }
              : {
                  // The migration moves no row with this transport, sse or
                  // stdio (ADR-211), so the row becomes an unnamed legacy row
                  // whatever it was. An sse row steering held before ADR-211
                  // would otherwise stay under projection, which retires it
                  // once its folder goes.
                  origin: "legacy",
                  steeringName: null,
                }),
            updatedAt: new Date(),
          },
        })
        .returning({
          publicId: schema.mcpServers.publicId,
        });
      return inserted ?? null;
    });

    emitEnabledChanged(ctx);

    logger.info(
      {
        orgListingId,
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        workspaceServerId: row?.publicId ?? null,
      },
      "set_plugin_enabled(workspace): enabled",
    );
    return { ok: true, workspaceServerId: row?.publicId ?? null };
  }

  // Disable: set enabled=false on the workspace MCP server row.
  try {
    await withTenantDb(async (tx) => {
      await tx
        .update(schema.mcpServers)
        .set({ enabled: false })
        .where(
          and(
            eq(schema.mcpServers.workspaceId, ctx.workspaceId!),
            eq(schema.mcpServers.orgListingId, orgListingId),
          ),
        );
    });
  } catch (err) {
    logger.error(
      { err, orgListingId, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      "set_plugin_enabled(workspace): disable failed",
    );
    throw err;
  }

  emitEnabledChanged(ctx);

  logger.info(
    { orgListingId, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
    "set_plugin_enabled(workspace): disabled",
  );
  return { ok: true, workspaceServerId: null };
};

export const handler: CapabilityHandlerFn = async (input, ctx) => {
  // The kernel's IAM check allows every capability for a non-enterprise org,
  // so the handler asks for the contract's roles itself (INV-29, #4194).
  await assertContractRole(pluginSetEnabled, ctx);
  const { scope } = input as Input;
  return scope === "org"
    ? setOrgEnabled(input, ctx)
    : setWorkspaceEnabled(input, ctx);
};
