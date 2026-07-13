// Capabilities source — the live capability registry.
//
// Contracts self-register on import (each file calls registerCapability). The
// canonical registration entrypoint is the "@oxagen/oxagen/contracts" barrel,
// which imports every contract file; after importing it, listCapabilities()
// from "@oxagen/oxagen/registry" returns the full set. We import ONLY those two
// subpaths — never the "@oxagen/oxagen" root barrel or "/kernel", which import
// @oxagen/database and would create a require cycle back into this package.
//
// reads/writes are BEST-EFFORT and derived only from the contract's produces/
// consumes data tags via TAG_TO_TABLES below. Data tags are semantic value
// tags ("graph.nodeId", "asset.id"), NOT table ids, so the mapping is a small,
// hand-verified set; any tag without an entry contributes nothing. Where a
// capability declares no produces/consumes, its reads/writes stay empty. The
// generator never guesses a table from a capability name — later PSO phases add
// handler-body scanning to populate these fully (ADR-031, Phase 1 scope note).

import "@oxagen/oxagen/contracts";
import { listCapabilities } from "@oxagen/oxagen/registry";
import type { ManifestCapability } from "../types";

/**
 * Explicit map from a capability data tag to the store table id(s) that tag
 * corresponds to. Deliberately small and conservative — only tags whose backing
 * table is unambiguous from the four-store model appear here. A `consumes` tag
 * maps to a READ; a `produces` tag maps to a WRITE.
 *
 * Graph tags → the universal :GraphNode anchor (every graph node carries it).
 * asset.id → content.generated_assets (the private-asset reference table).
 * document.text has no single owning table (it is derived content), so it is
 * intentionally absent rather than guessed.
 */
export const TAG_TO_TABLES: Record<string, readonly string[]> = {
  "graph.nodeId": ["neo4j:GraphNode"],
  "graph.relationshipId": ["neo4j:GraphNode"],
  "asset.id": ["postgres:content.generated_assets"],
};

function tablesForTags(tags: readonly string[] | undefined): string[] {
  if (!tags) return [];
  const out = new Set<string>();
  for (const tag of tags) {
    for (const table of TAG_TO_TABLES[tag] ?? []) out.add(table);
  }
  return [...out].sort();
}

/**
 * Collect every registered capability into the manifest shape. reads derive
 * from `consumes` tags, writes from `produces` tags (best-effort, may be empty).
 * Sorted by name; surfaces default to the public api+mcp pair when unset.
 */
export function collectCapabilities(): ManifestCapability[] {
  const caps = listCapabilities().map((cap): ManifestCapability => {
    const surfaces = [...(cap.surfaces ?? ["api", "mcp"])].sort();
    return {
      name: cap.name,
      domain: cap.domain,
      surfaces,
      reads: tablesForTags(cap.consumes),
      writes: tablesForTags(cap.produces),
    };
  });
  caps.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return caps;
}
