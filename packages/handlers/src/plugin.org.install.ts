import { and, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { schema, withSystemDb, withTenantDb } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import type { CapabilityContext } from "@oxagen/oxagen/types";
import { getOxagenPlugin } from "@oxagen/oxagen/plugins";
import {
  deriveAuthKind,
  deriveTransportTypes,
  listServers,
} from "@oxagen/plugins/registry";
import type { AuthKind } from "@oxagen/plugins/registry";
import { upsertCapabilityInstall } from "./capability-install";
import { logger } from "./logger";

export interface InstallOneInput {
  pluginType:
    | "mcp_server"
    | "integration"
    | "agent_skill"
    | "agent_capability"
    | "knowledge_source";
  // Required when pluginType === "agent_capability". Ignored for other types.
  pluginId?: string;
  // Marketplace catalog row id. Bulk callers (and the marketplace UI) identify a
  // capability by this field; it is accepted as a fallback for `pluginId` so a
  // bulk install that only carries catalogServerId still resolves the pack.
  catalogServerId?: string;
  custom?: {
    name: string;
    title?: string;
    description?: string;
    endpointUrl: string;
    transport: string;
    authKind: "oauth" | "secret" | "none";
  };
}

/**
 * Shared install logic — called by both plugin.org.install and plugin.org.install_bulk.
 * Workspace scope comes from ctx, never the request body (IDOR-safe).
 * Returns the installed plugin row id on success. Throws a descriptive Error on failure.
 */
export async function installOne(
  ctx: CapabilityContext,
  input: InstallOneInput,
): Promise<string> {
  if (!ctx.workspaceId) {
    throw new Error(
      "[plugin.org.install] workspaceId is required (scoped capability)",
    );
  }

  const { pluginType, custom } = input;
  // Bulk callers identify a capability by catalogServerId; accept it as a
  // fallback so install_bulk works without the caller pre-mapping to pluginId.
  const pluginId = input.pluginId ?? input.catalogServerId;

  // ── Oxagen capability pack path ─────────────────────────────────────────────
  if (pluginType === "agent_capability") {
    if (!pluginId) {
      throw new Error(
        "[plugin.org.install] pluginId (or catalogServerId) is required when pluginType is 'agent_capability'.",
      );
    }
    const manifest = getOxagenPlugin(pluginId);
    if (!manifest) {
      throw new Error(
        `[plugin.org.install] Unknown capability plugin: "${pluginId}". Check the Oxagen plugin registry.`,
      );
    }
    if (manifest.visibility === "hidden") {
      throw new Error(
        `[plugin.org.install] Plugin "${pluginId}" is not publicly installable (visibility: hidden).`,
      );
    }

    // Upsert the listing via the shared helper. Capability listings have no
    // endpoint/transport; authKind is "none" since capability packs are invoked
    // internally; source="oxagen" distinguishes first-party capability packs.
    // The same helper backs workspace-capability-seed so the write never drifts.
    const installedId = await withTenantDb((tx) =>
      upsertCapabilityInstall(tx, {
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId!,
        pluginId,
        manifest,
      }),
    );
    return installedId;
  }

  // ── MCP server / integration / agent_skill / knowledge_source path ──────────

  // custom config is required for non-capability types.
  if (!custom) {
    throw new Error(
      "[plugin.org.install] custom is required for non-agent_capability plugin types.",
    );
  }

  const { name, title, description } = custom;
  let { endpointUrl, transport, authKind } = custom;
  let source: "registry" | "custom" = "custom";

  // ── Registry-sourced install: empty endpointUrl means "resolve from registry" ──
  // When the app action passes endpointUrl: "" (a marketplace install, not a hand-
  // entered custom server), resolve the real endpoint live from the workspace's
  // enabled registries. This prevents storing an unusable empty endpoint URL.
  if (!endpointUrl || endpointUrl.trim() === "") {
    source = "registry";

    // Load enabled registries for this org+workspace.
    const registries = await withSystemDb((tx) =>
      tx
        .select({
          id: schema.mcpRegistries.id,
          baseUrl: schema.mcpRegistries.baseUrl,
        })
        .from(schema.mcpRegistries)
        .where(
          and(
            eq(schema.mcpRegistries.orgId, ctx.orgId),
            eq(schema.mcpRegistries.workspaceId, ctx.workspaceId!),
            eq(schema.mcpRegistries.enabled, true),
          ),
        ),
    );

    // Search each registry for the server by name; stop at the first match.
    let resolved = false;
    for (const reg of registries) {
      let result: Awaited<ReturnType<typeof listServers>>;
      try {
        result = await listServers(reg.baseUrl, { search: name, limit: 50 });
      } catch (err) {
        logger.warn(
          { err, registryId: reg.id, serverName: name },
          "plugin.org.install: registry fetch failed, skipping",
        );
        continue;
      }

      const match = result.servers.find((s) => s.server.name === name);
      if (!match) continue;

      const sd = match.server;

      // Prefer the first remote endpoint (hosted MCP server URL).
      const firstRemote = (sd.remotes ?? [])[0];
      if (firstRemote?.url) {
        endpointUrl = firstRemote.url;
        // Prefer registry-declared transport type; fallback to the remote's own type.
        const transportTypes = deriveTransportTypes(sd);
        transport = transportTypes[0] ?? firstRemote.type ?? transport;
        authKind = deriveAuthKind(sd) as AuthKind;
        resolved = true;
        logger.info(
          {
            registryId: reg.id,
            serverName: name,
            endpointUrl,
            transport,
            authKind,
          },
          "plugin.org.install: resolved endpoint from registry",
        );
        break;
      }

      // Server found but has no remote URL — log and keep searching.
      logger.warn(
        { registryId: reg.id, serverName: name },
        "plugin.org.install: server found in registry but has no remote endpoint, skipping",
      );
    }

    if (!resolved) {
      throw new Error(
        `[plugin.org.install] Server "${name}" not found in any connected registry. ` +
          `Ensure the server name matches exactly and at least one registry is enabled for this workspace.`,
      );
    }
  }

  // Resolve icon URL from the catalog_servers table (if synced) for a richer
  // installed-plugins display. Falls back to null if no catalog entry exists.
  let resolvedIconUrl: string | null = null;
  try {
    const catalogRow = await withTenantDb(async (tx) => {
      const rows = await tx
        .select({ icons: schema.mcpCatalogServers.icons })
        .from(schema.mcpCatalogServers)
        .where(
          and(
            eq(schema.mcpCatalogServers.name, name),
            eq(schema.mcpCatalogServers.isLatest, true),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    });
    if (catalogRow?.icons) {
      const icons = catalogRow.icons as Array<{ src?: string }>;
      const firstIcon = icons[0]?.src;
      if (firstIcon && /^https?:\/\//.test(firstIcon)) {
        resolvedIconUrl = firstIcon;
      }
    }
  } catch {
    // Non-fatal — icon lookup failure must never block install.
  }

  // Upsert the listing (enabled: true — all plugins are free, enable on install).
  // ON CONFLICT on the (org_id, workspace_id, plugin_type, name) unique index returns
  // the existing row's id — making install idempotent when the listing already exists.
  const inserted = await withTenantDb(async (tx) => {
    const [row] = await tx
      .insert(schema.pluginInstalledPlugins)
      .values({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId!,
        pluginType,
        source,
        name,
        title: title ?? null,
        description: description ?? null,
        iconUrl: resolvedIconUrl,
        endpointUrl,
        transport,
        authKind,
        enabled: true,
      })
      .onConflictDoUpdate({
        target: [
          schema.pluginInstalledPlugins.orgId,
          schema.pluginInstalledPlugins.workspaceId,
          schema.pluginInstalledPlugins.pluginType,
          schema.pluginInstalledPlugins.name,
        ],
        set: {
          iconUrl: sql`EXCLUDED.icon_url`,
          updatedAt: sql`now()`,
        },
      })
      .returning({ id: schema.pluginInstalledPlugins.id });
    return row ?? null;
  });

  if (!inserted) {
    throw new Error("[plugin.org.install] Insert returned no row.");
  }
  return inserted.id;
}

export const handler: CapabilityHandlerFn = async (input, ctx) => {
  const typed = input as InstallOneInput;
  let orgListingId: string;
  try {
    orgListingId = await installOne(ctx, typed);
  } catch (err) {
    logger.error(
      {
        err,
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        pluginType: typed.pluginType,
      },
      "plugin.org.install: failed",
    );
    throw err;
  }

  // ── Emit audit event (fire-and-forget; must not fail the capability) ────────
  emitSecurityEvent({
    eventType: "plugin.installed",
    actorUserId: ctx.userId ?? null,
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId ?? null,
    capability: "plugin.org.install",
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
      pluginType: typed.pluginType,
    },
    "plugin.org.install: ok",
  );
  return { orgListingId };
};
