import { and, eq } from "drizzle-orm";
import { schema, withTenantDb } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { logger } from "./logger";

export const handler: CapabilityHandlerFn = async (input, ctx) => {
  if (!ctx.workspaceId) {
    throw new Error("[plugin.org.set_enabled] workspaceId is required (scoped capability)");
  }
  const { orgListingId, enabled } = input as { orgListingId: string; enabled: boolean };

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
    logger.error({ err, orgListingId, orgId: ctx.orgId, workspaceId: ctx.workspaceId, enabled }, "plugin.org.set_enabled: failed");
    throw err;
  }

  // ── Emit audit event (fire-and-forget; must not fail the capability) ────────
  emitSecurityEvent({
    eventType: "plugin.enabled_changed",
    actorUserId: ctx.userId ?? null,
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId ?? null,
    capability: "plugin.org.set_enabled",
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: ctx.requestId ?? null,
  });

  logger.info({ orgListingId, orgId: ctx.orgId, workspaceId: ctx.workspaceId, enabled }, "plugin.org.set_enabled: ok");
  return { ok: true };
};
