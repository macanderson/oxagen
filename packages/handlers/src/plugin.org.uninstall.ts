import { and, eq, inArray, isNull } from "drizzle-orm";
import { schema, withTenantDb } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import { assertNoActiveKillSwitch } from "@oxagen/iam/kill-switch-guard";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { pluginOrgUninstall } from "@oxagen/oxagen/contracts/plugin.org.uninstall";
import { assertContractRole } from "./lib/capability-role-guard";
import { logger } from "./logger";

export const handler: CapabilityHandlerFn = async (input, ctx) => {
  if (!ctx.workspaceId) {
    throw new Error(
      "[plugin.org.uninstall] workspaceId is required (scoped capability)",
    );
  }
  // The kernel's IAM check allows every capability for a non-enterprise org,
  // so the handler asks for the contract's roles itself (INV-29, #4194).
  await assertContractRole(pluginOrgUninstall, ctx);
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

      // Uninstall drops the plugin listing and its MCP server rows, and
      // nothing else. Anything else a pack touched (environments, credentials)
      // is removed by an explicit, user-driven action, never as a silent
      // uninstall side effect.

      // Hard-delete dependent MCP server rows so the gateway drops them.
      // Scope by org + workspace (not orgListingId alone) so a guessed/leaked
      // listing id from another tenant can never delete that tenant's rows.
      const doomedServers = await tx
        .select({
          id: schema.mcpServers.id,
          publicId: schema.mcpServers.publicId,
        })
        .from(schema.mcpServers)
        .where(
          and(
            eq(schema.mcpServers.orgListingId, orgListingId),
            eq(schema.mcpServers.orgId, ctx.orgId),
            eq(schema.mcpServers.workspaceId, ctx.workspaceId!),
          ),
        );

      // A kill switch on one of these servers, or on a tool version of one,
      // denies on a digest over the server's INTERNAL uuid. Deleting the row
      // and reinstalling mints a new uuid the deny matches nothing against, so
      // the uninstall would dismantle the control while `list_kill_switches`
      // kept reporting it on (ADR-071). Turning the switch off is the way
      // through; uninstall is not.
      if (doomedServers.length > 0) {
        const serverIds = doomedServers.map((row) => row.id);
        const doomedVersions = await tx
          .select({ publicId: schema.toolVersions.publicId })
          .from(schema.toolVersions)
          .innerJoin(
            schema.tools,
            eq(schema.tools.id, schema.toolVersions.toolId),
          )
          .where(
            and(
              eq(schema.tools.orgId, ctx.orgId),
              eq(schema.tools.workspaceId, ctx.workspaceId!),
              inArray(schema.tools.mcpServerId, serverIds),
              isNull(schema.tools.deletedAt),
            ),
          );
        await assertNoActiveKillSwitch(tx, {
          orgId: ctx.orgId,
          targets: [
            ...doomedServers.map((row) => ({
              kind: "tool_server" as const,
              id: row.publicId,
            })),
            ...doomedVersions.map((row) => ({
              kind: "tool_version" as const,
              id: row.publicId,
            })),
          ],
          action: "Uninstalling this plugin",
        });
      }

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
