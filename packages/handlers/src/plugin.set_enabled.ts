import { and, eq, isNull, sql } from "drizzle-orm";
import {
  MOVABLE_TRANSPORTS,
  steeringWriter,
} from "@oxagen/agent/runtime/steering-pr";
import { proposeListingServer } from "@oxagen/agent/runtime/steering-proposal";
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
    // a steering PR. steeringWriter() is null until then. A plugin whose row
    // the repo already holds is still toggled on directly, below.
    const transportType = listing.transport ?? "sse";
    const movable = (MOVABLE_TRANSPORTS as readonly string[]).includes(transportType);
    const authStrategy = mapAuthStrategy(listing.authKind);
    const writer = movable
      ? await steeringWriter({ orgId: ctx.orgId, workspaceId: ctx.workspaceId })
      : null;
    if (writer !== null) {
      const outcome = await proposeListingServer(writer, {
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        listing: { id: listing.id, name: listing.name },
        values: {
          name: listing.name,
          transportType,
          endpointUrl: listing.endpointUrl,
          authStrategy,
          healthStatus: "unknown",
          discoveredTools: [],
        },
        refresh: { healthStatus: "unknown" },
        caller: "set_plugin_enabled(workspace)",
      });
      if (outcome.kind === "pending") {
        throw new HandlerError({
          code: "conflict",
          reason: "steering_pr_open",
          message: `"${listing.name}" turns on when the steering PR that adds tools/servers/${outcome.folder}/ merges and publishes.`,
        });
      }
      if (outcome.kind === "proposed") {
        emitEnabledChanged(ctx);
        logger.info(
          {
            orgListingId,
            orgId: ctx.orgId,
            workspaceId: ctx.workspaceId,
            workspaceServerId: outcome.publicId,
            steeringPr: outcome.pr.number,
          },
          "set_plugin_enabled(workspace): opened a steering PR",
        );
        return {
          ok: true,
          workspaceServerId: outcome.publicId,
          steeringPr: { number: outcome.pr.number, url: outcome.pr.url },
        };
      }
    }

    // Upsert the workspace MCP server row.

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
