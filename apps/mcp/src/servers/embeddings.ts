// embeddings.ts: rank a search-mode server's tools by the workspace's
// embeddings (lane M15; mcp-studio-spec, Large servers; ADR-217).
//
// The ranker reads the workspace's search index on each search. A workspace
// set to keyword has no index, so it ranks by keyword here. Any other
// failure throws, and search catches it and ranks by keyword, so a failed
// endpoint or a missing key never fails search.
import { entryText, type SearchIndex } from "@oxagen/mcp-studio";
import { keywordRank, type Ranker, type SearchEntry } from "./search";

/** Finds a workspace's search index, or null when the workspace ranks by keyword. */
export type SearchIndexLookup<S> = (scope: S) => Promise<SearchIndex | null>;

const RANK_BY = {
  // The line publish embedded for this tool, so its stored vector is found.
  text: (entry: SearchEntry) => entryText(entry.short, entry.summary),
  name: (entry: SearchEntry) => entry.short,
};

/** A ranker over the index the lookup finds for the scope. */
export function servedRanker<S>(scope: S, lookup: SearchIndexLookup<S>): Ranker {
  return async (query, entries, limit) => {
    const index = await lookup(scope);
    if (index === null) return keywordRank(query, entries, limit);
    return index.rank(query, entries, { ...RANK_BY, limit });
  };
}
