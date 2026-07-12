/**
 * timeline.ts — pure layout helpers for the fan-out detail timeline strip.
 *
 * aggregate_subagents.timeline is preferred (it's populated even while the
 * fanout is still running — the compact mode's whole point); get_subagent_fanout.runs
 * is the fallback when aggregate failed to load or its timeline came back
 * empty (e.g. a very fresh fanout with zero dispatched runs yet).
 */
import type { AgentSubagentFanoutGetOutput } from "@oxagen/oxagen/contracts/agent.subagent_fanout.get";
import type { AgentSubagentAggregateOutput } from "@oxagen/oxagen/contracts/agent.subagent.aggregate";

export interface TimelineEntry {
  runId: string;
  capabilityName: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  errorReason: string | null;
}

export function timelineEntriesFrom(
  fanout: AgentSubagentFanoutGetOutput,
  aggregate: AgentSubagentAggregateOutput | null,
): TimelineEntry[] {
  if (aggregate && aggregate.timeline.length > 0) {
    return aggregate.timeline;
  }
  return fanout.runs.map((r) => ({
    runId: r.runId,
    capabilityName: r.capabilityName,
    status: r.status,
    startedAt: r.startedAt,
    completedAt: r.completedAt,
    errorReason: r.errorReason,
  }));
}

export interface TimelineBar extends TimelineEntry {
  /** Left offset, percent of the timeline's total width. */
  offsetPct: number;
  /** Bar width, percent of the timeline's total width. */
  widthPct: number;
}

/**
 * Position each entry along a shared 0–100% axis spanning the earliest start
 * to the latest end (or `nowIso` for still-running entries). A run with no
 * `startedAt` yet (still queued) renders a minimal marker at the left edge
 * rather than being dropped.
 */
export function layoutTimeline(
  entries: TimelineEntry[],
  nowIso: string,
): TimelineBar[] {
  const starts = entries
    .map((e) => (e.startedAt ? new Date(e.startedAt).getTime() : null))
    .filter((n): n is number => n !== null && Number.isFinite(n));

  if (starts.length === 0) {
    return entries.map((e) => ({ ...e, offsetPct: 0, widthPct: 100 }));
  }

  const now = new Date(nowIso).getTime();
  const rangeStart = Math.min(...starts);
  const ends = entries
    .map((e) => {
      if (e.completedAt) {
        const t = new Date(e.completedAt).getTime();
        return Number.isFinite(t) ? t : null;
      }
      return e.startedAt ? now : null;
    })
    .filter((n): n is number => n !== null);
  const rangeEnd = Math.max(now, ...(ends.length > 0 ? ends : [rangeStart]));
  // Floor the span at 1s so a burst of same-millisecond runs doesn't divide by ~0.
  const span = Math.max(rangeEnd - rangeStart, 1000);

  return entries.map((e) => {
    if (!e.startedAt) return { ...e, offsetPct: 0, widthPct: 2 };
    const start = new Date(e.startedAt).getTime();
    const end = e.completedAt ? new Date(e.completedAt).getTime() : now;
    const offsetPct = Math.max(
      0,
      Math.min(100, ((start - rangeStart) / span) * 100),
    );
    const widthPct = Math.max(
      1.5,
      Math.min(100 - offsetPct, ((end - start) / span) * 100),
    );
    return { ...e, offsetPct, widthPct };
  });
}
