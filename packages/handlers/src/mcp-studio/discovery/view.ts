// view.ts: a discovery row as Studio reads it (lane M10, #4682). Dates become
// ISO strings, and `stalled` answers the question the hourly sweep asks.
import type { StudioDiscovery } from "@oxagen/oxagen/contracts/tool.studio.discovery.get";
import { STALLED_MS } from "./entry";
import type { DiscoveryRow } from "./store";

function iso(date: Date | null): string | null {
  return date === null ? null : date.toISOString();
}

/**
 * Whether the row has sat queued or run for over STALLED_MS, by the same
 * clocks the sweep's stalled query reads: a queued row by requestedAt, since
 * a new request can leave an older run's startedAt behind, and a running row
 * by startedAt, or requestedAt before the run records one.
 */
export function isStalled(
  row: Pick<DiscoveryRow, "status" | "requestedAt" | "startedAt">,
  now: Date,
): boolean {
  const cutoff = now.getTime() - STALLED_MS;
  if (row.status === "queued") return row.requestedAt.getTime() < cutoff;
  if (row.status === "running")
    return (row.startedAt ?? row.requestedAt).getTime() < cutoff;
  return false;
}

export function discoveryView(row: DiscoveryRow, now: Date): StudioDiscovery {
  return {
    id: row.id,
    server: row.server,
    mcpServerId: row.mcpServerId,
    status: row.status,
    trigger: row.trigger,
    requestedAt: row.requestedAt.toISOString(),
    requestedBy: row.requestedBy,
    startedAt: iso(row.startedAt),
    finishedAt: iso(row.finishedAt),
    error: row.error,
    outcome: row.outcome,
    toolCount: row.toolCount,
    machine: row.machine,
    sourceKind: row.sourceKind,
    sourceRepo: row.sourceRepo,
    sourcePath: row.sourcePath,
    sourceRef: row.sourceRef,
    schedule: row.schedule,
    upstreamDigest: row.upstreamDigest,
    latestVersion: row.latestVersion,
    pr: row.pr,
    withheld: [...row.withheld],
    stalled: isStalled(row, now),
  };
}
