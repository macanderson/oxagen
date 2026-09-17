/**
 * The plugin entitlement filter every agent tool list applies: a capability
 * a plugin claims is listed only when the org has that plugin installed and
 * enabled. `list_agent_tools` and the in-app agent's belt outside a turn
 * (`search_tools`, `load_tools`) read through it; `materializeTools` hands the
 * same fail-closed entitled set to `decideCapabilityForBelt` (toolbelt.ts),
 * so no list shows a tool the kernel would refuse for want of the plugin.
 *
 * The entitled set is fetched once, on the first plugin-claimed capability,
 * so a list of builtins never reads the database. A failed fetch fails
 * closed: every plugin-claimed capability is excluded and builtins stay.
 */
import pino from "pino";
import { pluginForContract } from "@oxagen/oxagen/plugins";
import { listEntitledCapabilityPluginIds } from "@oxagen/plugins";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "agent.plugin-entitlement" },
});

/** Answers whether the org may be shown `capabilityName`. */
export type EntitlementFilter = (capabilityName: string) => Promise<boolean>;

export function createEntitlementFilter(scope: {
  orgId: string;
  workspaceId: string;
}): EntitlementFilter {
  let entitled: Promise<Set<string> | null> | null = null;
  return async (capabilityName) => {
    const plugin = pluginForContract(capabilityName);
    if (!plugin) return true;
    entitled ??= listEntitledCapabilityPluginIds(
      scope.orgId,
      scope.workspaceId,
    ).catch((err: unknown) => {
      logger.warn(
        { err, orgId: scope.orgId, workspaceId: scope.workspaceId },
        "entitlement fetch failed — excluding all plugin-claimed capabilities (fail-closed)",
      );
      return null;
    });
    const ids = await entitled;
    return ids !== null && ids.has(plugin.id);
  };
}
