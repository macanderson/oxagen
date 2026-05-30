"use client";
import * as React from "react";
import { Check, Loader2, Users, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { safeJson } from "./tool-call-card";
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
      className="glass-panel my-2 space-y-3 p-4 animate-in"
      data-component="subagent-fanout"
      data-fanout-status={status}
    >
      <div className="flex items-center gap-2">
        <Users className="h-4 w-4 text-accent" />
        <Badge variant="muted">{subagents.length} subagents</Badge>
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
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Aggregated result
          </div>
          <pre className="overflow-x-auto rounded-lg bg-muted/40 p-2 font-mono text-xs">
            {safeJson(results)}
          </pre>
        </div>
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
  const status: SubagentStatus = child.status ?? (output !== undefined ? "completed" : "running");
  return (
    <button
      type="button"
      onClick={() => onSelect?.(child.childMessageId)}
      data-role="child"
      data-child-status={status}
      className={cn(
        "glass min-w-[10rem] flex-1 rounded-xl border border-[color:var(--glass-border)] p-2 text-left text-xs transition-all hover:translate-y-[-1px]",
      )}
    >
      <div className="flex items-center gap-2">
        <ChildStatusIcon status={status} />
        <span className="truncate font-medium">{child.label ?? child.capability}</span>
      </div>
      <div className="mt-1 font-mono text-[10px] text-muted-foreground">{child.capability}</div>
    </button>
  );
}

function FanoutStatus({ status }: { status: SubagentStatus }) {
  if (status === "running") {
    return (
      <Badge variant="muted" className="ml-auto">
        <Loader2 className="mr-1 h-3 w-3 animate-spin" /> Running
      </Badge>
    );
  }
  if (status === "completed") {
    return (
      <Badge variant="success" className="ml-auto">
        <Check className="mr-1 h-3 w-3" /> Completed
      </Badge>
    );
  }
  if (status === "timed_out") {
    return (
      <Badge variant="destructive" className="ml-auto">
        <X className="mr-1 h-3 w-3" /> Timed out
      </Badge>
    );
  }
  return (
    <Badge variant="warn" className="ml-auto">
      Partial
    </Badge>
  );
}

function ChildStatusIcon({ status }: { status: SubagentStatus }) {
  if (status === "running") return <Loader2 className="h-3 w-3 animate-spin text-accent" />;
  if (status === "completed") return <Check className="h-3 w-3 text-emerald-500" />;
  return <X className="h-3 w-3 text-destructive" />;
}
