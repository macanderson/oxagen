import { and, eq } from "drizzle-orm";
import { schema, withTenantDb } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { logger } from "./logger";

export const handler: CapabilityHandlerFn = async (input, ctx) => {
  if (!ctx.workspaceId) {
    throw new Error(
      "[plugin.org.uninstall] workspaceId is required (scoped capability)",
    );
  }
  const { orgListingId } = input as { orgListingId: string };

  try {
    await withTenantDb(async (tx) => {
      // Soft-delete the listing scoped to this org + workspace.
      await tx
        .update(schema.pluginInstalledPlugins)
        .set({ deletedAt: new Date() })
        .where(
          and(
            eq(schema.pluginInstalledPlugins.id, orgListingId),
            eq(schema.pluginInstalledPlugins.orgId, ctx.orgId),
            eq(schema.pluginInstalledPlugins.workspaceId, ctx.workspaceId!),
          ),
        );

      // NOTE (Spec §6): sandbox templates seeded by a capability pack install
      // are deliberately NOT removed here. A template may already back a live
      // agent-environment binding or be in use by an in-flight run, so its
      // removal is an explicit, user-driven action (delete_sandbox_template),
      // never a silent uninstall side effect. Uninstall only drops the plugin
      // listing and its MCP server rows.

      // Hard-delete dependent MCP server rows so the runtime drops them.
      // Scope by org + workspace (not orgListingId alone) so a guessed/leaked
      // listing id from another tenant can never delete that tenant's rows.
      await tx
        .delete(schema.mcpServers)
        .where(
          and(
            eq(schema.mcpServers.orgListingId, orgListingId),
            eq(schema.mcpServers.orgId, ctx.orgId),
            eq(schema.mcpServers.workspaceId, ctx.workspaceId!),
          ),
        );
    });
  } catch (err) {
    logger.error(
      { err, orgListingId, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      "plugin.org.uninstall: failed",
    );
    throw err;
  }

  // ── Emit audit event (fire-and-forget; must not fail the capability) ────────
  emitSecurityEvent({
    eventType: "plugin.uninstalled",
    actorUserId: ctx.userId ?? null,
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId ?? null,
    capability: "uninstall_plugin",
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: ctx.requestId ?? null,
  });

  logger.info(
    { orgListingId, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
    "plugin.org.uninstall: ok",
  );
  return { ok: true };
};
