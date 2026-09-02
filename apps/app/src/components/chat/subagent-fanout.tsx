"use client";
import * as React from "react";
import { Check, Loader2, Users, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { StructuredField } from "./structured-value";
import type { SubagentChild, SubagentStatus } from "./stream-event-types";

export interface SubagentFanoutProps {
  fanoutId: string;
  parentMessageId: string;
  subagents: SubagentChild[];
  status: SubagentStatus;
  results?: Array<{ childMessageId: string; output: unknown }>;
  onSelectChild?: (childMessageId: string) => void;
}

export function SubagentFanout({
  subagents,
  status,
  results,
  onSelectChild,
}: SubagentFanoutProps) {
  const resultMap = React.useMemo(() => {
    const map = new Map<string, unknown>();
    for (const r of results ?? []) map.set(r.childMessageId, r.output);
    return map;
  }, [results]);

  return (
    <div
      className="rounded-xl border bg-card text-card-foreground shadow my-2 space-y-3 p-4 animate-in"
      data-component="subagent-fanout"
      data-fanout-status={status}
    >
      <div className="flex items-center gap-2">
        <Users className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <span className="text-xs font-medium text-muted-foreground">
          {subagents.length} subagent{subagents.length === 1 ? "" : "s"}
        </span>
        <FanoutStatus status={status} />
      </div>

      <div className="flex flex-wrap gap-2">
        {subagents.map((child) => (
          <ChildCard
            key={child.childMessageId}
            child={child}
            output={resultMap.get(child.childMessageId)}
            onSelect={onSelectChild}
          />
        ))}
      </div>

      {status !== "running" && results && results.length > 0 ? (
        <StructuredField
          label="Aggregated result"
          value={results.map((r) => r.output)}
        />
      ) : null}
    </div>
  );
}

function ChildCard({
  child,
  output,
  onSelect,
}: {
  child: SubagentChild;
  output: unknown;
  onSelect?: (childMessageId: string) => void;
}) {
  const status: SubagentStatus =
    child.status ?? (output !== undefined ? "completed" : "running");
  return (
    <button
      type="button"
      onClick={() => onSelect?.(child.childMessageId)}
      data-role="child"
      data-child-status={status}
      className={cn(
        "min-w-[10rem] flex-1 rounded-xl border bg-card p-2 text-left text-xs transition-all hover:translate-y-[-1px] hover:shadow-sm",
      )}
    >
      <div className="flex items-center gap-2">
        <ChildStatusIcon status={status} />
        <span className="truncate font-medium">
          {child.label ?? child.capability}
        </span>
      </div>
      <div className="mt-1 font-mono text-[10px] text-muted-foreground">
        {child.capability}
      </div>
    </button>
  );
}

function FanoutStatus({ status }: { status: SubagentStatus }) {
  if (status === "running") {
    return (
      <span className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" /> Running
      </span>
    );
  }
  if (status === "completed") {
    return (
      <span className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-success">
        <Check className="h-3 w-3" /> Completed
      </span>
    );
  }
  if (status === "timed_out") {
    return (
      <span className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-destructive">
        <X className="h-3 w-3" /> Timed out
      </span>
    );
  }
  return (
    <span className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-warning">
      Partial
    </span>
  );
}

function ChildStatusIcon({ status }: { status: SubagentStatus }) {
  if (status === "running")
    return <Loader2 className="h-3 w-3 animate-spin text-foreground" />;
  if (status === "completed") return <Check className="h-3 w-3 text-success" />;
  return <X className="h-3 w-3 text-destructive" />;
}
