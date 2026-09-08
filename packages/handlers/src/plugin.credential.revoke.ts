import { and, eq, isNull } from "drizzle-orm";
import { schema, withTenantDb } from "@oxagen/database";
import { deleteWorkspaceSecret } from "@oxagen/plugins";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { logger } from "./logger";
import { emitSecurityEvent } from "@oxagen/database/security";

/**
 * Revokes (deletes) the stored credential for an installed plugin in this
 * workspace — the "Remove authentication" action. After revocation the
 * workspace must re-authenticate (OAuth or secret) before the server can be
 * used again. NEVER logs secret material — only ids.
 */
export const handler: CapabilityHandlerFn = async (input, ctx) => {
  const { orgListingId } = input as { orgListingId: string };

  if (!ctx.workspaceId) {
    throw new Error(
      "[plugin.credential.revoke] workspaceId is required (scoped capability)",
    );
  }

  // Load the installed plugin row — must belong to this org + workspace.
  const listing = await withTenantDb(async (tx) => {
    const [row] = await tx
      .select({ id: schema.pluginInstalledPlugins.id })
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
      `[plugin.credential.revoke] Installed plugin not found or deleted: ${orgListingId}`,
    );
  }

  let revoked: boolean;
  try {
    revoked = await deleteWorkspaceSecret({
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      orgListingId,
    });
  } catch (err) {
    logger.error(
      { err, orgListingId, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      "plugin.credential.revoke: failed",
    );
    throw err;
  }

  // A plugin's stored OAuth token or secret is a privileged credential, and
  // SOC2 CC6.1 asks that setting or deleting one leave a trail. This handler
  // used to carry an audit-exempt comment saying the taxonomy had no fitting
  // type. It does now (oxagen#2533).
  emitSecurityEvent({
    eventType: "plugin.credential_revoked",
    actorUserId: ctx.userId ?? null,
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    capability: "revoke_plugin_credential",
    outcome: "success",
    ip: null,
    userAgent: null,
    requestId: ctx.requestId ?? null,
  });

  // Audit-relevant record of the destructive credential delete: who (ctx ids),
  // what (orgListingId), and whether a credential actually existed.
  logger.info(
    {
      orgListingId,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      userId: ctx.userId ?? null,
      requestId: ctx.requestId ?? null,
      revoked,
    },
    "plugin.credential.revoke: credential deleted",
  );
  return { revoked };
};
