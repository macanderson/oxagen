"use client";
/**
 * swarm-session-store.ts — client-side tracking for in-session research
 * swarms.
 *
 * CONTRACT GAP: research.swarm.start never inserts an agent_executions row
 * (verified against packages/handlers/src/research.swarm.start.ts — no
 * `agentExecutions` insert, unlike workflow.run), so there is no server-side
 * list surface for swarms at all — nothing for agent.execution.list to filter
 * on, and no workflow.list-equivalent capability exists either. Until a
 * research.swarm.list-shaped capability lands, records live in
 * sessionStorage, keyed per org+workspace: they persist across a page
 * refresh in the same tab, but are lost on tab close and are never visible
 * from another browser or device. The Swarms tab flags this explicitly.
 */
import { useCallback, useEffect, useState } from "react";

export interface SwarmSessionRecord {
  swarmId: string;
  dispatchId: string;
  topic: string;
  depth: "shallow" | "medium" | "deep";
  maxParallel: number;
  targetLabel: string;
  status: "running" | "complete" | "failed";
  completedTasks: number;
  totalTasks: number;
  /** ISO timestamp captured client-side at launch time. */
  launchedAt: string;
}

function storageKey(orgSlug: string, workspaceSlug: string): string {
  return `oxagen:workflows:swarms:${orgSlug}:${workspaceSlug}`;
}

function readStore(key: string): SwarmSessionRecord[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SwarmSessionRecord[]) : [];
  } catch {
    return [];
  }
}

function writeStore(key: string, records: SwarmSessionRecord[]): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(key, JSON.stringify(records));
  } catch {
    // sessionStorage may be unavailable (private-mode quota, disabled
    // storage) — the Swarms tab just won't persist across a reload; launching
    // a swarm still works either way.
  }
}

export interface SwarmSessionStore {
  swarms: SwarmSessionRecord[];
  addSwarm: (record: SwarmSessionRecord) => void;
  updateSwarm: (swarmId: string, patch: Partial<SwarmSessionRecord>) => void;
  /**
   * Re-read sessionStorage into state. The launch dialog rendered in the page
   * header owns a *separate* instance of this hook (it only needs `addSwarm`),
   * so a swarm launched from there won't appear in the table's own instance
   * until it resyncs — call this when the Swarms tab becomes active or on a
   * poll tick rather than wiring a cross-instance event bus for one field.
   */
  refresh: () => void;
}

/** React hook over the sessionStorage-backed swarm list for one workspace. */
export function useSwarmSessionStore(
  orgSlug: string,
  workspaceSlug: string,
): SwarmSessionStore {
  const key = storageKey(orgSlug, workspaceSlug);
  const [swarms, setSwarms] = useState<SwarmSessionRecord[]>([]);

  // Read on mount only — sessionStorage is client-only, so this must happen
  // in an effect (not render) to avoid an SSR/hydration mismatch.
  useEffect(() => {
    setSwarms(readStore(key));
  }, [key]);

  const refresh = useCallback(() => {
    setSwarms(readStore(key));
  }, [key]);

  const addSwarm = useCallback(
    (record: SwarmSessionRecord) => {
      setSwarms((prev) => {
        const next = [
          record,
          ...prev.filter((s) => s.swarmId !== record.swarmId),
        ];
        writeStore(key, next);
        return next;
      });
    },
    [key],
  );

  const updateSwarm = useCallback(
    (swarmId: string, patch: Partial<SwarmSessionRecord>) => {
      setSwarms((prev) => {
        const next = prev.map((s) =>
          s.swarmId === swarmId ? { ...s, ...patch } : s,
        );
        writeStore(key, next);
        return next;
      });
    },
    [key],
  );

  return { swarms, addSwarm, updateSwarm, refresh };
}
