import { and, eq, isNull, sql } from "drizzle-orm";
import { schema, withTenantDb } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
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

  // ── Emit audit event (fire-and-forget; must not fail the capability) ────────
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
          transportType: listing.transport ?? "sse",
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
            updatedAt: new Date(),
          },
        })
        .returning({
          publicId: schema.mcpServers.publicId,
        });
      return inserted ?? null;
    });

    // ── Emit audit event (fire-and-forget; must not fail the capability) ──────
    emitSecurityEvent({
      eventType: "plugin.enabled_changed",
      actorUserId: ctx.userId ?? null,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId!,
      capability: "set_plugin_enabled",
      outcome: "success",
      ip: null,
      userAgent: null,
      requestId: ctx.requestId ?? null,
    });

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

  // ── Emit audit event (fire-and-forget; must not fail the capability) ──────
  emitSecurityEvent({
    eventType: "plugin.enabled_changed",
    actorUserId: ctx.userId ?? null,
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId!,
    capability: "set_plugin_enabled",
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: ctx.requestId ?? null,
  });

  logger.info(
    { orgListingId, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
    "set_plugin_enabled(workspace): disabled",
  );
  return { ok: true, workspaceServerId: null };
};

export const handler: CapabilityHandlerFn = async (input, ctx) => {
  const { scope } = input as Input;
  return scope === "org"
    ? setOrgEnabled(input, ctx)
    : setWorkspaceEnabled(input, ctx);
};
