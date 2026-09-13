"use client";

import * as React from "react";
import type { MentionType } from "@oxagen/ai/mentions";
import type { MentionSearchResult } from "./mention-meta";

const DEBOUNCE_MS = 160;

/**
 * Debounced reference search for the @-mention picker's second stage.
 * POSTs /api/reference-search (invoke("search_references") server-side) with
 * the selected type as the filter; degrades to an empty result set on any
 * failure so the menu never blocks typing.
 */
export function useMentionSearch(params: {
  orgSlug: string | undefined;
  workspaceSlug: string | undefined;
  type: MentionType | null;
  query: string;
  enabled: boolean;
}): { results: MentionSearchResult[]; loading: boolean } {
  const { orgSlug, workspaceSlug, type, query, enabled } = params;
  const [results, setResults] = React.useState<MentionSearchResult[]>([]);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (!enabled || !type || !orgSlug || !workspaceSlug) {
      setResults([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch("/api/reference-search", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            orgSlug,
            workspaceSlug,
            query,
            types: [type],
            limit: 8,
          }),
        });
        if (!res.ok) throw new Error(`search failed (${res.status})`);
        const json = (await res.json()) as { results?: MentionSearchResult[] };
        if (!cancelled) setResults(json.results ?? []);
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, type, query, orgSlug, workspaceSlug]);

  return { results, loading };
}
