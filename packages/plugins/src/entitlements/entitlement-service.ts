/**
 * entitlement-service.ts — capability-plugin entitlement queries + kernel gate.
 *
 * Queries `plugin.org_listings` (plugin_type='capability', enabled=true, not
 * soft-deleted) minus any names present in `plugin.org_denylist` for the same
 * org and type. Returns the set of listing `name` values — which hold the
 * Oxagen plugin id (e.g. "oxagen/media-svg").
 *
 * Includes a 30-second in-memory TTL cache keyed by orgId to avoid a DB round-
 * trip on every capability invocation.
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

/** Remove all cache entries. Call in test teardown / beforeEach. */
export function clearEntitlementCacheForTests(): void {
  cache.clear();
}

// ── DB query ──────────────────────────────────────────────────────────────────

/**
 * Return the set of capability plugin ids (e.g. "oxagen/media-svg") that are
 * installed AND enabled for the given org, excluding any that appear in the
 * org's denylist.
 *
 * Results are cached for 30 seconds per orgId.
 */
export async function listEntitledCapabilityPluginIds(
  orgId: string,
): Promise<Set<string>> {
  const now = Date.now();
  const cached = cache.get(orgId);
  if (cached && cached.expires > now) {
    return cached.set;
  }

  const entitled = await withSystemDb(async (tx) => {
    const [listingRows, denylistRows] = await Promise.all([
      tx
        .select({ name: schema.pluginOrgListings.name })
        .from(schema.pluginOrgListings)
        .where(
          and(
            eq(schema.pluginOrgListings.orgId, orgId),
            eq(schema.pluginOrgListings.pluginType, "capability"),
            eq(schema.pluginOrgListings.enabled, true),
            isNull(schema.pluginOrgListings.deletedAt),
          ),
        ),
      tx
        .select({ serverName: schema.pluginOrgDenylist.serverName })
        .from(schema.pluginOrgDenylist)
        .where(
          and(
            eq(schema.pluginOrgDenylist.orgId, orgId),
            eq(schema.pluginOrgDenylist.pluginType, "capability"),
          ),
        ),
    ]);

    const deniedNames = new Set(denylistRows.map((r) => r.serverName));
    const result = new Set<string>();
    for (const row of listingRows) {
      if (!deniedNames.has(row.name)) {
        result.add(row.name);
      }
    }
    return result;
  });

  cache.set(orgId, { expires: now + CACHE_TTL_MS, set: entitled });
  return entitled;
}

// ── Kernel gate ───────────────────────────────────────────────────────────────

/**
 * Capability entitlement gate — injected into the kernel via
 * `setCapabilityEntitlementGate` from `bootstrapEntitlementRuntime()`.
 *
 * Logic:
 * - If the capability is unclaimed by any plugin → return (builtin, always available).
 * - If claimed but the plugin id is NOT in the org's entitled set → throw
 *   `capabilityNotInstalledError` (code: "capability_not_installed").
 * - If claimed and the plugin id IS in the entitled set → return (allow).
 */
export async function capabilityEntitlementGate(
  capabilityName: string,
  orgId: string,
): Promise<void> {
  const plugin = pluginForContract(capabilityName);
  // Unclaimed → builtin; the kernel skips these, but be defensive.
  if (!plugin) return;

  const entitled = await listEntitledCapabilityPluginIds(orgId);
  if (!entitled.has(plugin.id)) {
    throw capabilityNotInstalledError(capabilityName, plugin.id, plugin.name);
  }
}
