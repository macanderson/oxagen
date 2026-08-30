import { emitSecurityEvent } from "@oxagen/database/security";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { installOne, type InstallOneInput } from "./plugin.org.install";
import { logger } from "./logger";

export const handler: CapabilityHandlerFn = async (input, ctx) => {
  const { items } = input as { items: InstallOneInput[] };

  const installed = await Promise.all(
    items.map(async (item) => {
      try {
        const { id: orgListingId, authKind } = await installOne(ctx, item);
        // ── Emit audit event per installed item (fire-and-forget) ───────────
        emitSecurityEvent({
          eventType: "plugin.installed",
          actorUserId: ctx.userId ?? null,
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId ?? null,
          capability: "install_plugins_bulk",
          outcome: "success",
          ip: null,
          userAgent: null,
          requestId: ctx.requestId ?? null,
        });
        logger.info(
          {
            orgListingId,
            orgId: ctx.orgId,
            pluginType: item.pluginType,
            pluginId: item.pluginId ?? null,
          },
          "plugin.org.install_bulk: item installed",
        );
        return {
          pluginId: item.pluginId ?? null,
          orgListingId,
          authKind,
          error: null,
        };
      } catch (err) {
        logger.error(
          {
            err,
            orgId: ctx.orgId,
            pluginType: item.pluginType,
            pluginId: item.pluginId ?? null,
          },
          "plugin.org.install_bulk: item failed",
        );
        return {
          pluginId: item.pluginId ?? null,
          orgListingId: null,
          authKind: null,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  const failCount = installed.filter((r) => r.error !== null).length;
  logger.info(
    { orgId: ctx.orgId, total: items.length, failCount },
    "plugin.org.install_bulk: complete",
  );
  return { installed };
};
