/**
 * entitlement-service.ts — capability-plugin entitlement queries + kernel gate.
 *
 * Queries `plugin.installed_plugins` (plugin_type='agent_capability',
 * enabled=true, not soft-deleted) for a specific (orgId, workspaceId). Returns
 * the set of `name` values — which hold the capability plugin id
 * (e.g. "oxagen/media-svg").
 *
 * Entitlement is WORKSPACE-SCOPED: a capability pack installed in one workspace
 * does not entitle sibling workspaces in the same org. There is no org-level
 * pre-approval / denylist — workspaces install whatever they want.
 *
 * Includes a 30-second in-memory TTL cache keyed by `${orgId}:${workspaceId}`
 * to avoid a DB round-trip on every capability invocation.
 */

import { and, eq, isNull } from "drizzle-orm";
import { schema, withSystemDb } from "@oxagen/database";
import { pluginForContract } from "@oxagen/oxagen/plugins";
import { capabilityNotInstalledError } from "@oxagen/oxagen/kernel";

// ── TTL cache ─────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  expires: number;
  set: Set<string>;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(orgId: string, workspaceId: string): string {
  return `${orgId}:${workspaceId}`;
}

/** Remove all cache entries. Call in test teardown / beforeEach. */
export function clearEntitlementCacheForTests(): void {
  cache.clear();
}

// ── DB query ──────────────────────────────────────────────────────────────────

/**
 * Return the set of capability plugin ids (e.g. "oxagen/media-svg") that are
 * installed AND enabled for the given (orgId, workspaceId).
 *
 * Results are cached for 30 seconds per (orgId, workspaceId). Two consequences
 * callers must know about:
 *
 * - The cache is not invalidated on install/uninstall/disable, so a REVOKED
 *   entitlement keeps passing the gate for up to CACHE_TTL_MS. That is a
 *   deliberate fail-open window traded for one DB round-trip per invocation;
 *   it is not suitable as the sole control for an urgent revocation.
 * - The returned Set is the CACHED instance, not a copy. Mutating it (`.add`,
 *   `.delete`) rewrites the entitlements every later gate check in this process
 *   sees. Treat it as read-only.
 */
export async function listEntitledCapabilityPluginIds(
  orgId: string,
  workspaceId: string,
): Promise<Set<string>> {
  const now = Date.now();
  const key = cacheKey(orgId, workspaceId);
  const cached = cache.get(key);
  if (cached && cached.expires > now) {
    return cached.set;
  }

  const entitled = await withSystemDb(async (tx) => {
    const listingRows = await tx
      .select({ name: schema.pluginInstalledPlugins.name })
      .from(schema.pluginInstalledPlugins)
      .where(
        and(
          eq(schema.pluginInstalledPlugins.orgId, orgId),
          eq(schema.pluginInstalledPlugins.workspaceId, workspaceId),
          eq(schema.pluginInstalledPlugins.pluginType, "agent_capability"),
          eq(schema.pluginInstalledPlugins.enabled, true),
          isNull(schema.pluginInstalledPlugins.deletedAt),
        ),
      );

    const result = new Set<string>();
    for (const row of listingRows) {
      result.add(row.name);
    }
    return result;
  });

  cache.set(key, { expires: now + CACHE_TTL_MS, set: entitled });
  return entitled;
}

// ── Kernel gate ───────────────────────────────────────────────────────────────

/**
 * Capability entitlement gate — injected into the kernel via
 * `setCapabilityEntitlementGate` from `bootstrapEntitlementRuntime()`.
 *
 * Logic:
 * - If the capability is unclaimed by any plugin → return (builtin, always available).
 * - If claimed but the plugin id is NOT in the workspace's entitled set → throw
 *   `capabilityNotInstalledError` (code: "capability_not_installed").
 * - If claimed and the plugin id IS in the entitled set → return (allow).
 */
export async function capabilityEntitlementGate(
  capabilityName: string,
  orgId: string,
  workspaceId: string,
): Promise<void> {
  const plugin = pluginForContract(capabilityName);
  // Unclaimed → builtin; the kernel skips these, but be defensive.
  if (!plugin) return;

  const entitled = await listEntitledCapabilityPluginIds(orgId, workspaceId);
  if (!entitled.has(plugin.id)) {
    throw capabilityNotInstalledError(capabilityName, plugin.id, plugin.name);
  }
}
