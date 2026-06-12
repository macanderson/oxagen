import { and, eq, sql } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import type { CapabilityContext } from "@oxagen/oxagen/types";
import { getOxagenPlugin } from "@oxagen/oxagen/plugins";
import { logger } from "./logger";

export interface InstallOneInput {
  pluginType: "mcp_server" | "integration" | "content_tool" | "capability";
  // Required when pluginType === "capability". Ignored for other types.
  pluginId?: string;
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
 * Returns the orgListingId on success. Throws a descriptive Error on failure.
 */
export async function installOne(
  ctx: CapabilityContext,
  input: InstallOneInput,
): Promise<string> {
  const { pluginType, pluginId, catalogServerId, custom } = input;

  // ── Capability (Oxagen Plugin) path ─────────────────────────────────────────
  if (pluginType === "capability") {
    if (!pluginId) {
      throw new Error(
        "[plugin.org.install] pluginId is required when pluginType is 'capability'.",
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

    // Reject if the name is on the denylist for this org + capability type.
    const denied = await withSystemDb(async (tx) => {
      const [row] = await tx
        .select({ id: schema.pluginOrgDenylist.id })
        .from(schema.pluginOrgDenylist)
        .where(
          and(
            eq(schema.pluginOrgDenylist.orgId, ctx.orgId),
            eq(schema.pluginOrgDenylist.pluginType, "capability"),
            eq(schema.pluginOrgDenylist.serverName, pluginId),
          ),
        )
        .limit(1);
      return row ?? null;
    });
    if (denied) {
      throw new Error(
        `[plugin.org.install] Plugin "${pluginId}" is on the org denylist for type "capability".`,
      );
    }

    // Upsert the listing. Capability listings have no endpoint/transport — both
    // columns are nullable in plugin.org_listings (no notNull constraint in schema).
    // authKind is "none" since capability packs are invoked internally, not over
    // a network transport. source="oxagen" distinguishes first-party capability packs.
    const inserted = await withSystemDb(async (tx) => {
      const [row] = await tx
        .insert(schema.pluginOrgListings)
        .values({
          orgId: ctx.orgId,
          pluginType: "capability",
          catalogServerId: null,
          source: "oxagen",
          name: pluginId,
          title: manifest.name,
          description: manifest.description,
          iconUrl: manifest.icon ?? null,
          endpointUrl: null,
          transport: null,
          authKind: "none",
          enabled: false,
        })
        .onConflictDoUpdate({
          target: [
            schema.pluginOrgListings.orgId,
            schema.pluginOrgListings.pluginType,
            schema.pluginOrgListings.name,
          ],
          set: { updatedAt: sql`now()` },
        })
        .returning({ id: schema.pluginOrgListings.id });
      return row ?? null;
    });

    if (!inserted) {
      throw new Error("[plugin.org.install] Capability insert returned no row.");
    }
    return inserted.id;
  }

  // ── MCP server / integration / content_tool path ────────────────────────────

  // Exactly one of catalogServerId / custom must be provided.
  const hasCatalog = catalogServerId !== undefined && catalogServerId !== null;
  const hasCustom = custom !== undefined && custom !== null;
  if (hasCatalog === hasCustom) {
    throw new Error(
      "[plugin.org.install] Provide exactly one of catalogServerId or custom, not both (or neither).",
    );
  }

  let name: string;
  let title: string | null = null;
  let description: string | null = null;
  let iconUrl: string | null = null;
  let endpointUrl: string | null = null;
  let transport: string | null = null;
  let authKind: string;
  let source: "registry" | "custom";

  if (hasCatalog) {
    // Load catalog row.
    const catalogRow = await withSystemDb(async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.mcpCatalogServers)
        .where(eq(schema.mcpCatalogServers.id, catalogServerId!))
        .limit(1);
      return row ?? null;
    });
    if (!catalogRow) {
      throw new Error(`[plugin.org.install] Catalog server not found: ${catalogServerId}`);
    }
    // Derive the remote endpoint — the first remote's url/type.
    const remotes = (catalogRow.remotes as Array<{ url?: string; type?: string }>) ?? [];
    const firstRemote = remotes[0];
    if (!firstRemote?.url) {
      throw new Error(
        `[plugin.org.install] Catalog server "${catalogRow.name}" has no remote endpoint. Local-only servers cannot be installed via the org allow-list.`,
      );
    }
    name = catalogRow.name;
    title = catalogRow.title ?? null;
    description = catalogRow.description;
    iconUrl =
      ((catalogRow.icons as Array<{ src?: string }>)?.[0]?.src) ?? null;
    endpointUrl = firstRemote.url;
    transport = firstRemote.type ?? catalogRow.transportTypes[0] ?? "sse";
    authKind = catalogRow.authKind;
    source = "registry";
  } else {
    // Custom server.
    name = custom!.name;
    title = custom!.title ?? null;
    description = custom!.description ?? null;
    endpointUrl = custom!.endpointUrl;
    transport = custom!.transport;
    authKind = custom!.authKind;
    source = "custom";
  }

  // Reject if the name is on the denylist for this org + type.
  const denied = await withSystemDb(async (tx) => {
    const [row] = await tx
      .select({ id: schema.pluginOrgDenylist.id })
      .from(schema.pluginOrgDenylist)
      .where(
        and(
          eq(schema.pluginOrgDenylist.orgId, ctx.orgId),
          eq(schema.pluginOrgDenylist.pluginType, pluginType),
          eq(schema.pluginOrgDenylist.serverName, name),
        ),
      )
      .limit(1);
    return row ?? null;
  });
  if (denied) {
    throw new Error(
      `[plugin.org.install] Server "${name}" is on the org denylist for type "${pluginType}".`,
    );
  }

  // Upsert the listing (enabled: false by default).
  // ON CONFLICT on the (org_id, plugin_type, name) unique index returns the
  // existing row's id — making install idempotent when the listing already exists.
  const inserted = await withSystemDb(async (tx) => {
    const [row] = await tx
      .insert(schema.pluginOrgListings)
      .values({
        orgId: ctx.orgId,
        pluginType,
        catalogServerId: catalogServerId ?? null,
        source,
        name,
        title,
        description,
        iconUrl,
        endpointUrl,
        transport,
        authKind,
        enabled: false,
      })
      .onConflictDoUpdate({
        target: [schema.pluginOrgListings.orgId, schema.pluginOrgListings.pluginType, schema.pluginOrgListings.name],
        set: { updatedAt: sql`now()` },
      })
      .returning({ id: schema.pluginOrgListings.id });
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
    logger.error({ err, orgId: ctx.orgId, pluginType: typed.pluginType }, "plugin.org.install: failed");
    throw err;
  }

  // ── Emit audit event (fire-and-forget; must not fail the capability) ────────
  emitSecurityEvent({
    eventType: "plugin.installed",
    actorUserId: ctx.userId ?? null,
    orgId: ctx.orgId,
    workspaceId: null,
    capability: "plugin.org.install",
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: ctx.requestId ?? null,
  });

  logger.info({ orgListingId, orgId: ctx.orgId, pluginType: typed.pluginType }, "plugin.org.install: ok");
  return { orgListingId };
};
