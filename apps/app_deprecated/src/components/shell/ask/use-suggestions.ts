"use client";
/**
 * use-suggestions.ts
 *
 * Client hook that fetches LLM-powered "Suggested for this page" items from
 * POST /api/command-menu/suggestions.
 *
 * Caching layers (per spec §7):
 *   - In-memory client cache: per route+entity, TTL 5 min.
 *   - Server cache: Vercel Runtime Cache, TTL 1 hour, keyed by context hash.
 *
 * Spec §7 graceful degradation:
 *   - If the fetch exceeds 800ms or fails, the spinner is dropped and the
 *     section collapses. The rest of the menu renders normally.
 *   - The 800ms deadline hides the spinner; it does NOT abort the request. A
 *     response that lands after the deadline still populates the section (and
 *     the client cache), so a slow first open can pop suggestions in late.
 *
 * The hook accepts a `ScopeContext` (orgSlug + workspaceSlug) and the full
 * PageContext so it can build a SuggestionContext automatically.
 */

import * as React from "react";
import type { PageEntity } from "@/lib/page-context";

export interface SuggestionItem {
  text: string;
  category: "create" | "investigate" | "configure" | "communicate" | "analyze";
  confidence: number;
}

interface UseSuggestionsArgs {
  /** Current pathname (from next/navigation). */
  pathname: string;
  /** Org slug for the API call. */
  orgSlug: string;
  /** Workspace slug for the API call. */
  workspaceSlug: string;
  /** Registered page entity (from usePageContext). */
  pageEntity: PageEntity | null;
  /** Last 5 recent queries from useRecent (entity refs are best-effort). */
  recentLabels: string[];
  /** Whether the command menu is currently open — suggestions only load when open. */
  isOpen: boolean;
}

interface UseSuggestionsResult {
  suggestions: SuggestionItem[];
  /** True while the fetch is in-flight (for the ≤500ms skeleton reveal). */
  loading: boolean;
}

/**
 * 5-minute in-memory client cache. Maps a cache key → { items, fetchedAt }.
 *
 * Module-scoped and never evicted: the TTL only makes an entry stale, it never
 * removes it, so the map grows by one entry per distinct route+entity the user
 * opens the menu on and only clears on a full page load.
 */
const CLIENT_CACHE = new Map<
  string,
  { items: SuggestionItem[]; fetchedAt: number }
>();
const CLIENT_TTL_MS = 5 * 60 * 1000;

/** Derive a stable cache key from the route + page entity id (not session). */
function clientCacheKey(
  pathname: string,
  entityId: string | undefined,
): string {
  return `${pathname}::${entityId ?? "none"}`;
}

/** Spec §7: hide the spinner if the LLM call hasn't returned within 800ms. */
const FETCH_TIMEOUT_MS = 800;

export function useSuggestions({
  pathname,
  orgSlug,
  workspaceSlug,
  pageEntity,
  recentLabels,
  isOpen,
}: UseSuggestionsArgs): UseSuggestionsResult {
  const [suggestions, setSuggestions] = React.useState<SuggestionItem[]>([]);
  const [loading, setLoading] = React.useState(false);

  // Derive a stable cache key. Only re-fetch when route or entity changes.
  const cacheKey = clientCacheKey(pathname, pageEntity?.id);

  React.useEffect(() => {
    // Only fetch when the menu is open.
    if (!isOpen) return;

    // Client cache hit — serve immediately without loading state.
    const cached = CLIENT_CACHE.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < CLIENT_TTL_MS) {
      setSuggestions(cached.items);
      setLoading(false);
      return;
    }

    // Start fetch.
    setLoading(true);
    let cancelled = false;

    const timeoutId = setTimeout(() => {
      // Spec §7: if not returned within 800ms, clear loading so the section
      // collapses. The in-flight request is deliberately left running — its
      // result still lands in the cache for the next open.
      if (!cancelled) {
        setLoading(false);
        setSuggestions([]);
      }
    }, FETCH_TIMEOUT_MS);

    const body = {
      orgSlug,
      workspaceSlug,
      route: pathname,
      routeParams: {},
      queryParams: {},
      pageEntity: pageEntity
        ? {
            kind: pageEntity.kind,
            id: pageEntity.id,
            label: pageEntity.label,
            summary: pageEntity.summary,
          }
        : undefined,
      recentEntities: recentLabels.slice(0, 5).map((label) => ({
        kind: "unknown",
        id: label,
        label,
      })),
      capabilities: [],
      locale: navigator.language.split("-")[0] ?? "en",
    };

    fetch("/api/command-menu/suggestions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(async (res) => {
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { suggestions?: SuggestionItem[] };
        const items = Array.isArray(data.suggestions) ? data.suggestions : [];
        CLIENT_CACHE.set(cacheKey, { items, fetchedAt: Date.now() });
        if (!cancelled) {
          setSuggestions(items);
        }
      })
      .catch(() => {
        // Spec §7: errors silently result in empty suggestions.
        if (!cancelled) setSuggestions([]);
      })
      .finally(() => {
        clearTimeout(timeoutId);
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [
    isOpen,
    cacheKey,
    orgSlug,
    workspaceSlug,
    pathname,
    pageEntity,
    recentLabels,
  ]);

  return { suggestions, loading };
}
