"use client";
/**
 * use-recent.ts — track the last 5 queries in localStorage.
 *
 * Entries are keyed globally (not per-workspace) so they survive navigation.
 * The list is capped at MAX_RECENT items; duplicates are deduplicated (most
 * recent position wins).
 */

import * as React from "react";

const STORAGE_KEY = "oxagen:ask:recent";
const MAX_RECENT = 5;

export interface RecentEntry {
  query: string;
  /** ISO timestamp of the last use — for display only. */
  at: string;
}

/** Returns the current recent entries (newest first). */
function readRecent(): RecentEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return (parsed as RecentEntry[]).slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

/** Prepend a new entry, deduplicate, and cap at MAX_RECENT. */
function pushRecent(query: string): RecentEntry[] {
  const trimmed = query.trim();
  if (!trimmed) return readRecent();
  const existing = readRecent().filter((e) => e.query !== trimmed);
  const updated: RecentEntry[] = [
    { query: trimmed, at: new Date().toISOString() },
    ...existing,
  ].slice(0, MAX_RECENT);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  } catch {
    // localStorage unavailable — silently skip.
  }
  return updated;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseRecentReturn {
  recent: RecentEntry[];
  /** Call after a query is submitted to persist it. */
  push: (query: string) => void;
  /** Clear the recent list. */
  clear: () => void;
}

export function useRecent(): UseRecentReturn {
  // Lazy initializer: readRecent() guards `typeof window`, so a server render
  // never touches localStorage and yields []. NOTE: the initializer also runs
  // during client hydration, where it CAN return stored entries — so any
  // consumer that renders `recent` during the hydrating pass must be inside a
  // client-only boundary (the command menu renders its list only once opened).
  const [recent, setRecent] = React.useState<RecentEntry[]>(readRecent);

  const push = React.useCallback((query: string) => {
    const updated = pushRecent(query);
    setRecent(updated);
  }, []);

  const clear = React.useCallback(() => {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
    setRecent([]);
  }, []);

  return { recent, push, clear };
}
