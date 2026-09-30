// listed.ts: the tools a succeeded listing wrote into its draft, each with
// the classification Studio suggests (ADR-233, #4756).
//
// A new server that runs on machines has no folder, so Studio's Tools tab,
// which reads the folder, cannot show its tools. get_studio_listing carries
// them instead, and Add server imports and classifies them before Review.
// The tools are read from the draft, not from the listing row: the draft is
// what Review builds from, so the two cannot disagree.
import type { StudioListedTool } from "@oxagen/oxagen/contracts/tool.studio.listing.get";
import { parseServerToml, suggest } from "@oxagen/mcp-studio";
import { selectedName, suggestNetwork } from "../import/build";
import { importSource } from "../import/source";
import type { StoredStudioDraft } from "../import/store";
import type { StoredListing } from "./store";

/**
 * The listed tools, or null when there are none to show: the listing has not
 * succeeded, or a save since then left the draft with no MCP source or no
 * server.toml. A draft whose source or server.toml no longer reads is null
 * too. Review refuses that draft with the reason, so the poll that reads
 * progress never fails on it.
 */
export async function listedTools(
  listing: StoredListing,
  draft: StoredStudioDraft | null,
): Promise<StudioListedTool[] | null> {
  if (listing.status !== "succeeded" || draft === null) return null;
  // The listing's own write raised the revision past the one it was asked on.
  if (draft.revision <= listing.draftRevision) return null;
  if (draft.source?.type !== "mcp" || draft.serverToml === null) return null;
  const server = parseServerToml(draft.serverToml);
  if (!server.ok) return null;
  let offered;
  try {
    offered = (await importSource(draft.source)).offered;
  } catch {
    return null;
  }
  const context = {
    source: server.value.source.type,
    network: suggestNetwork(server.value),
  };
  return offered.map((tool) => {
    const suggestion = suggest(tool, context);
    return {
      name: selectedName(tool),
      description: tool.description ?? null,
      suggested: {
        risk: suggestion.risk,
        sideEffect: suggestion.side_effect,
        egress: suggestion.egress,
        impacts: [...suggestion.impacts],
      },
    };
  });
}
