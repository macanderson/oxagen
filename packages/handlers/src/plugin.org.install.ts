import { sql } from "drizzle-orm";
import { schema, withTenantDb } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import type { CapabilityContext } from "@oxagen/oxagen/types";
import { getOxagenPlugin } from "@oxagen/oxagen/plugins";
import { logger } from "./logger";

export interface InstallOneInput {
  pluginType: "mcp_server" | "integration" | "agent_skill" | "agent_capability" | "knowledge_source";
  // Required when pluginType === "agent_capability". Ignored for other types.
  pluginId?: string;
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
    throw new Error("[plugin.org.install] workspaceId is required (scoped capability)");
  }

  const { pluginType, pluginId, custom } = input;

  // ── Oxagen capability pack path ─────────────────────────────────────────────
  if (pluginType === "agent_capability") {
    if (!pluginId) {
      throw new Error(
        "[plugin.org.install] pluginId is required when pluginType is 'agent_capability'.",
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

    // Upsert the listing. Capability listings have no endpoint/transport.
    // authKind is "none" since capability packs are invoked internally.
    // source="oxagen" distinguishes first-party capability packs.
    const inserted = await withTenantDb(async (tx) => {
      const [row] = await tx
        .insert(schema.pluginInstalledPlugins)
        .values({
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId!,
          pluginType: "agent_capability",
          source: "oxagen",
          name: pluginId,
          title: manifest.name,
          description: manifest.description,
          // iconUrl is a Lucide icon name on capability packs, not a URL — leave null
          // to avoid a broken next/image src in the org plugins panel.
          iconUrl: null,
          endpointUrl: null,
          transport: null,
          authKind: "none",
          enabled: true,
        })
        .onConflictDoUpdate({
          target: [
            schema.pluginInstalledPlugins.orgId,
            schema.pluginInstalledPlugins.workspaceId,
            schema.pluginInstalledPlugins.pluginType,
            schema.pluginInstalledPlugins.name,
          ],
          set: { updatedAt: sql`now()` },
        })
        .returning({ id: schema.pluginInstalledPlugins.id });
      return row ?? null;
    });

    if (!inserted) {
      throw new Error("[plugin.org.install] Capability insert returned no row.");
    }
    return inserted.id;
  }

  // ── MCP server / integration / agent_skill / knowledge_source path ──────────

  // custom config is required for non-capability types.
  if (!custom) {
    throw new Error(
      "[plugin.org.install] custom is required for non-agent_capability plugin types.",
    );
  }

  const { name, title, description, endpointUrl, transport, authKind } = custom;

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
        source: "custom",
        name,
        title: title ?? null,
        description: description ?? null,
        iconUrl: null,
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
        set: { updatedAt: sql`now()` },
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
    logger.error({ err, orgId: ctx.orgId, workspaceId: ctx.workspaceId, pluginType: typed.pluginType }, "plugin.org.install: failed");
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

  logger.info({ orgListingId, orgId: ctx.orgId, workspaceId: ctx.workspaceId, pluginType: typed.pluginType }, "plugin.org.install: ok");
  return { orgListingId };
};
