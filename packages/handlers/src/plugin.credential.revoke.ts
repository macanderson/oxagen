// audit-exempt: deletes a plugin OAuth/secret credential. No fitting security-event type exists in the current taxonomy (there is no plugin.credential_* family). The destructive delete is recorded by the audit-relevant log line below and the kernel capability.invoke_* audit records the privileged invocation. Re-evaluate when a plugin.credential.* taxonomy is added.
import { and, eq, isNull } from "drizzle-orm";
import { schema, withTenantDb } from "@oxagen/database";
import { deleteWorkspaceSecret } from "@oxagen/plugins";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { logger } from "./logger";

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
