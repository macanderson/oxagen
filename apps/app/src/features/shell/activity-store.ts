"use client";
// What the current workspace says is waiting (ARCHITECTURE.md §1.2, mockup
// `sidebar()`): its nav counts and the bell's feed. The workspace layout reads
// them, because only it knows which workspace the URL is in, and the chrome
// draws them, because the chrome is where the sidebar and the bell live. The
// two are siblings, not ancestor and child, so the workspace layer publishes
// here and the chrome subscribes.
//
// One slot, keyed by the workspace slug, so a chrome on a different workspace
// (or on an organization page) never draws another workspace's figures.
import { useEffect, useSyncExternalStore } from "react";
import type { NavCounts, NotificationFeed } from "@/data/contracts/shell";
import type { Read } from "@/data/read";

export type WorkspaceActivity = {
  slug: string;
  counts: Read<NavCounts>;
  feed: Read<NotificationFeed>;
};

let current: WorkspaceActivity | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The current workspace's activity, or null outside a workspace. */
export function useWorkspaceActivity(
  slug: string | null,
): WorkspaceActivity | null {
  const value = useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
  return value !== null && value.slug === slug ? value : null;
}

/** Rendered by the workspace layer: publishes what it read, and withdraws it on leaving. */
export function WorkspaceActivitySync({
  activity,
}: {
  activity: WorkspaceActivity;
}) {
  useEffect(() => {
    current = activity;
    emit();
    return () => {
      if (current === activity) {
        current = null;
        emit();
      }
    };
  }, [activity]);
  return null;
}
