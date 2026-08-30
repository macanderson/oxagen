import type { CapabilityDeclaration, CapabilityHandler } from "@oxagen/oxagen";
import {
  getSurfaces,
  listCapabilities,
  pluginForContract,
} from "@oxagen/oxagen";
import {
  capabilityRegistryList,
  type CapabilityRegistrySummary,
} from "@oxagen/oxagen/contracts/capability.registry.list";
import { logger } from "./logger";

/**
 * capability.registry.list handler.
 *
 * Reads the live in-process contract registry (`listCapabilities()` — the same
 * source the manifest gate introspects) and projects each declaration to the
 * serializable catalog summary. Pure platform metadata: no tenant data is read,
 * so no DB round-trip. Sorting is by name for a stable catalog order;
 * pagination is applied after filtering.
 */

const KNOWN_LAYERS = new Set([
  "schema",
  "api",
  "mcp",
  "unit",
  "e2e",
  "docs",
  "app",
]);

/** Project one registered declaration to the catalog summary shape. */
export function projectCapabilitySummary(
  cap: CapabilityDeclaration,
): CapabilityRegistrySummary {
  const plugin = pluginForContract(cap.name);
  return {
    name: cap.name,
    domain: cap.domain,
    description: cap.description,
    mode: cap.mode,
    surfaces: [...getSurfaces(cap)],
    // Defensive filter: the registry is typed, but layers[] flows into a
    // z.enum on the output schema — drop anything unknown rather than throw.
    layers: cap.layers.filter(
      (l): l is CapabilityRegistrySummary["layers"][number] =>
        KNOWN_LAYERS.has(l),
    ),
    sensitivity: cap.sensitivity,
    defaultEffect: cap.defaultEffect,
    scoped: cap.scoped ?? true,
    noBillingGate: cap.noBillingGate ?? false,
    agent: cap.agent
      ? {
          requiresApproval: cap.agent.requiresApproval ?? false,
          riskLevel: cap.agent.riskLevel ?? "low",
          category: cap.agent.category ?? null,
        }
      : null,
    auditTargetKind: cap.audit?.targetKind ?? null,
    plugin: plugin
      ? {
          id: plugin.id,
          tier: plugin.tier,
          minPlanTier: plugin.minPlanTier ?? null,
        }
      : null,
    orgRoles: { ...cap.defaultRoles.org },
    workspaceRoles: { ...cap.defaultRoles.workspace },
  };
}

export const capabilityRegistryListHandler: CapabilityHandler<
  typeof capabilityRegistryList
> = async (input, ctx) => {
  const all = listCapabilities();

  const domains = [...new Set(all.map((c) => c.domain))].sort();

  const q = input.q?.toLowerCase();
  const filtered = all.filter((cap) => {
    if (input.domain && cap.domain !== input.domain) return false;
    if (input.surface && !getSurfaces(cap).includes(input.surface))
      return false;
    if (input.missingLayer && cap.layers.includes(input.missingLayer))
      return false;
    if (input.sensitivity && cap.sensitivity !== input.sensitivity)
      return false;
    if (
      q &&
      !cap.name.toLowerCase().includes(q) &&
      !cap.domain.toLowerCase().includes(q) &&
      !cap.description.toLowerCase().includes(q)
    ) {
      return false;
    }
    return true;
  });

  filtered.sort((a, b) => a.name.localeCompare(b.name));

  const page = filtered.slice(input.offset, input.offset + input.limit);

  logger.info(
    { orgId: ctx.orgId, total: filtered.length, returned: page.length },
    "capability.registry.list: catalog read",
  );

  return {
    capabilities: page.map(projectCapabilitySummary),
    total: filtered.length,
    hasMore: filtered.length > input.offset + input.limit,
    limit: input.limit,
    offset: input.offset,
    domains,
  };
};
