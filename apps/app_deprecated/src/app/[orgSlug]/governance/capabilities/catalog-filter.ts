import type { CapabilityRegistrySummary } from "@oxagen/oxagen/contracts/capability.registry.list";

/**
 * Pure client-side filtering for the Capability & Contract catalog.
 * The server page fetches the full registry once (platform metadata, ~few
 * hundred rows); search/filter interactions run locally with no round-trip.
 */

/** Layers every production capability is expected to declare. */
export const CORE_LAYERS = ["api", "mcp", "docs", "app"] as const;
export type CoreLayer = (typeof CORE_LAYERS)[number];

/** True when the contract omits at least one core layer (a surface gap). */
export function hasSurfaceGap(row: CapabilityRegistrySummary): boolean {
  return CORE_LAYERS.some((layer) => !row.layers.includes(layer));
}

/** The core layers the contract omits (for gap badges). */
export function missingCoreLayers(row: CapabilityRegistrySummary): CoreLayer[] {
  return CORE_LAYERS.filter((layer) => !row.layers.includes(layer));
}

/** Org roles granted 'allow' by default — the identity column of the table. */
export function allowedOrgRoles(row: CapabilityRegistrySummary): string[] {
  return Object.entries(row.orgRoles)
    .filter(([, effect]) => effect === "allow")
    .map(([role]) => role)
    .sort();
}

export interface CatalogFilterState {
  q: string;
  /** Empty string = all domains. */
  domain: string;
  /** Only rows missing at least one core layer. */
  gapOnly: boolean;
  /** Only rows NOT declaring this layer (hub deep-link, e.g. "e2e"). */
  missingLayer: string;
}

export const EMPTY_FILTER: CatalogFilterState = {
  q: "",
  domain: "",
  gapOnly: false,
  missingLayer: "",
};

export function filterCatalog(
  rows: readonly CapabilityRegistrySummary[],
  state: CatalogFilterState,
): CapabilityRegistrySummary[] {
  const q = state.q.trim().toLowerCase();
  return rows.filter((row) => {
    if (state.domain && row.domain !== state.domain) return false;
    if (state.gapOnly && !hasSurfaceGap(row)) return false;
    if (
      state.missingLayer &&
      (row.layers as readonly string[]).includes(state.missingLayer)
    ) {
      return false;
    }
    if (
      q &&
      !row.name.toLowerCase().includes(q) &&
      !row.domain.toLowerCase().includes(q) &&
      !row.description.toLowerCase().includes(q)
    ) {
      return false;
    }
    return true;
  });
}
