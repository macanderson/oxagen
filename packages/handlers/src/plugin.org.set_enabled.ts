import { and, eq } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { logger } from "./logger";

export const handler: CapabilityHandlerFn = async (input, ctx) => {
  const { orgListingId, enabled } = input as { orgListingId: string; enabled: boolean };

  try {
    await withSystemDb(async (tx) => {
      await tx
        .update(schema.pluginOrgListings)
        .set({ enabled })
        .where(
          and(
            eq(schema.pluginOrgListings.id, orgListingId),
            eq(schema.pluginOrgListings.orgId, ctx.orgId),
          ),
        );
    });
  } catch (err) {
    logger.error({ err, orgListingId, orgId: ctx.orgId, enabled }, "plugin.org.set_enabled: failed");
    throw err;
  }

  // ── Emit audit event (fire-and-forget; must not fail the capability) ────────
  emitSecurityEvent({
    eventType: "plugin.enabled_changed",
    actorUserId: ctx.userId ?? null,
    orgId: ctx.orgId,
    workspaceId: null,
    capability: "plugin.org.set_enabled",
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: ctx.requestId ?? null,
  });

  logger.info({ orgListingId, orgId: ctx.orgId, enabled }, "plugin.org.set_enabled: ok");
  return { ok: true };
};
