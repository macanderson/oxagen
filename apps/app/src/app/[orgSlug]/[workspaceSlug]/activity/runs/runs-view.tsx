"use client";
/**
 * runs-view.tsx — the unified Activity → Runs surface (IA spec §5).
 *
 * Runs is the single home for ALL run kinds. Today two kinds are live and
 * wired: subagent fan-outs (`agent.subagent.fanout.list`) and parallel tasks
 * (agent executions, formerly the standalone /workflows page). Chat/API/MCP
 * runs land here too once `activity.runs.list` (ClickHouse) ships — until then
 * they're surfaced as a "coming soon" note rather than a fake-live mock.
 *
 * Filter chips switch the visible kind. The fan-out list keeps its own live
 * polling; the task table is static (executions are terminal-or-slow).
 */
import * as React from "react";
import { Info, Network } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardPanel } from "@/components/ui/card";
import { FanoutList, type FanoutRow } from "./fanout-list";
import { TaskTable, type RunTask } from "./task-table";

type RunFilter = "all" | "fanouts" | "tasks";

export interface RunsViewProps {
  fanouts: FanoutRow[];
  tasks: RunTask[];
  orgSlug: string;
  workspaceSlug: string;
}

export function RunsView({ fanouts, tasks, orgSlug, workspaceSlug }: RunsViewProps) {
  const [filter, setFilter] = React.useState<RunFilter>("all");

  const chips: { id: RunFilter; label: string; count: number }[] = [
    { id: "all", label: "All", count: fanouts.length + tasks.length },
    { id: "fanouts", label: "Subagent fan-outs", count: fanouts.length },
    { id: "tasks", label: "Parallel tasks", count: tasks.length },
  ];

  const showFanouts = filter === "all" || filter === "fanouts";
  const showTasks = filter === "all" || filter === "tasks";
  const both = filter === "all";
  const empty = fanouts.length === 0 && tasks.length === 0;

  return (
    <div className="flex flex-col gap-5" data-testid="runs-view">
      {/* Preview pill: chat/API/MCP runs aren't wired until activity.runs.list ships. */}
      <div className="flex items-center justify-end">
        <span className="inline-flex items-center gap-1 rounded-full border border-border/50 bg-muted/50 px-2.5 py-0.5 text-[11px] text-muted-foreground">
          <Info className="h-3 w-3" aria-hidden="true" />
          Chat / API / MCP runs coming soon
        </span>
      </div>

      {/* Filter chips by kind (spec §5). */}
      <div role="tablist" aria-label="Filter runs by kind" className="flex flex-wrap gap-2">
        {chips.map((chip) => (
          <button
            key={chip.id}
            type="button"
            role="tab"
            aria-selected={filter === chip.id}
            onClick={() => setFilter(chip.id)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              filter === chip.id
                ? "border-primary/30 bg-primary/10 text-primary"
                : "border-border/60 bg-card text-muted-foreground hover:bg-accent",
            )}
          >
            {chip.label}
            <span className="tabular-nums opacity-70">{chip.count}</span>
          </button>
        ))}
      </div>

      {empty ? (
        <Card>
          <CardPanel className="flex flex-col items-center gap-2 py-12 text-center">
            <Network className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm font-medium">No runs yet</p>
            <p className="max-w-md text-xs text-muted-foreground">
              When agents fan out subagents or run parallel tasks, every run shows up here
              with live status. Ask the agent to research something at scale to get started.
            </p>
          </CardPanel>
        </Card>
      ) : (
        <>
          {showFanouts && (
            <section className="flex flex-col gap-2">
              {both && (
                <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Subagent fan-outs
                </h2>
              )}
              <FanoutList
                initialFanouts={fanouts}
                orgSlug={orgSlug}
                workspaceSlug={workspaceSlug}
              />
            </section>
          )}

          {showTasks && (
            <section className="flex flex-col gap-2">
              {both && (
                <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Parallel tasks
                </h2>
              )}
              {tasks.length === 0 ? (
                <Card>
                  <CardPanel className="py-8 text-center text-xs text-muted-foreground">
                    No parallel tasks yet.
                  </CardPanel>
                </Card>
              ) : (
                <TaskTable tasks={tasks} />
              )}
            </section>
          )}
        </>
      )}

      <p className="text-xs text-muted-foreground">
        Runs are retained for 90 days on Build plan, 1 year on Scale and Enterprise.
        Parallel tasks run up to 500 concurrent children. Token costs appear in Billing → Usage.
      </p>
    </div>
  );
}
