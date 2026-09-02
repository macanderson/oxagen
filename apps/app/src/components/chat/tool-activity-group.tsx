"use client";
import * as React from "react";
import { Check, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { ToolCallCard, formatDuration } from "./tool-call-card";
import { toolCallMeta } from "./tool-call-meta";
import { toolCallSummary } from "./tool-call-summary";
import type { RiskLevel, ToolCallStatus } from "./stream-event-types";

/**
 * tool-activity-group — a RUN of consecutive tool calls rendered as ONE quiet,
 * collapsed unit.
 *
 * Tool calls happen constantly; individually they are noise. What matters is
 * (a) that the agent is working and not hung, and (b) what the LAST call was.
 * So this component NEVER expands by default: while live it shows a single
 * spinner line naming the current call; when finished it shows a single muted
 * summary line. The user can click to expand into one-line rows, each of which
 * opens the full detail (ToolCallCard body) inline. No risk badges, no red —
 * the conversation history stays readable.
 */

export interface ToolActivityItem {
  toolCallId: string;
  capability: string;
  inputPreview: unknown;
  riskLevel: RiskLevel;
  status: ToolCallStatus;
  output?: unknown;
  stdout?: string;
  stderr?: string;
  errorReason?: string;
  durationMs?: number;
}

export interface ToolActivityGroupProps {
  items: ToolActivityItem[];
  /** True while the turn is streaming — drives the live "working" line. */
  live: boolean;
}

function isInFlight(status: ToolCallStatus): boolean {
  return status === "pending" || status === "running";
}

/** The muted human detail for a call: its label, plus a one-line input summary
 *  when there is something salient to show. */
function callDetail(item: ToolActivityItem): {
  label: string;
  summary: string | null;
} {
  const { label } = toolCallMeta(item.capability);
  return {
    label,
    summary: toolCallSummary(item.capability, item.inputPreview),
  };
}

export function ToolActivityGroup({ items, live }: ToolActivityGroupProps) {
  const [expanded, setExpanded] = React.useState(false);
  const [openRows, setOpenRows] = React.useState<ReadonlySet<string>>(
    () => new Set(),
  );

  if (items.length === 0) return null;

  const anyInFlight = items.some((i) => isInFlight(i.status));
  const showLive = live && anyInFlight;
  const latest = items[items.length - 1]!;
  const failedCount = items.filter((i) => i.status === "failed").length;
  const totalDuration = items.reduce((sum, i) => sum + (i.durationMs ?? 0), 0);

  const toggleRow = (id: string) =>
    setOpenRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const latestDetail = callDetail(latest);

  return (
    <div
      className="my-1 text-sm"
      data-component="tool-activity-group"
      data-testid="tool-activity-group"
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-label={
          expanded ? "Collapse tool activity" : "Expand tool activity"
        }
        className="flex min-h-7 w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors hover:bg-muted/50"
      >
        {expanded ? (
          <ChevronDown
            className="h-3 w-3 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
        ) : (
          <ChevronRight
            className="h-3 w-3 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
        )}
        {showLive ? (
          <Loader2
            className="h-3 w-3 shrink-0 animate-spin text-muted-foreground"
            aria-label="Working"
          />
        ) : (
          <Check
            className="h-3 w-3 shrink-0 text-muted-foreground"
            aria-label="Done"
          />
        )}
        {showLive ? (
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <span className="truncate text-foreground">
              {latestDetail.label}
            </span>
            {latestDetail.summary ? (
              <span className="truncate text-muted-foreground">
                · {latestDetail.summary}
              </span>
            ) : null}
          </span>
        ) : (
          <span className="flex min-w-0 flex-1 items-center gap-1.5 text-muted-foreground">
            <span className="shrink-0">
              {items.length} tool call{items.length === 1 ? "" : "s"}
              {totalDuration > 0 ? ` · ${formatDuration(totalDuration)}` : ""}
            </span>
            <span className="truncate">
              · {latestDetail.label}
              {latestDetail.summary ? ` · ${latestDetail.summary}` : ""}
            </span>
            {failedCount > 0 ? (
              <span className="shrink-0">
                · {failedCount} issue{failedCount === 1 ? "" : "s"}
              </span>
            ) : null}
          </span>
        )}
        {showLive && items.length > 1 ? (
          <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">
            step {items.length}
          </span>
        ) : null}
      </button>

      {expanded ? (
        <div className="mt-1 space-y-0.5 pl-2">
          {items.map((item) => {
            const { label, summary } = callDetail(item);
            const { Icon } = toolCallMeta(item.capability);
            const rowOpen = openRows.has(item.toolCallId);
            return (
              <div
                key={item.toolCallId}
                data-testid={`tool-activity-row-${item.toolCallId}`}
              >
                <button
                  type="button"
                  onClick={() => toggleRow(item.toolCallId)}
                  aria-expanded={rowOpen}
                  className="flex min-h-6 w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors hover:bg-muted/50"
                >
                  <Icon
                    className="h-3 w-3 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span className="shrink-0 truncate text-foreground">
                    {label}
                  </span>
                  {summary ? (
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                      · {summary}
                    </span>
                  ) : (
                    <span className="min-w-0 flex-1" />
                  )}
                  {item.status === "failed" ? (
                    <span className="inline-flex shrink-0 items-center gap-1 text-muted-foreground">
                      <span
                        className="inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground/70"
                        aria-hidden="true"
                      />
                      failed
                    </span>
                  ) : null}
                  {isInFlight(item.status) ? (
                    <Loader2
                      className="h-3 w-3 shrink-0 animate-spin text-muted-foreground"
                      aria-label="Running"
                    />
                  ) : item.durationMs != null ? (
                    <span className="shrink-0 text-muted-foreground tabular-nums">
                      {formatDuration(item.durationMs)}
                    </span>
                  ) : null}
                </button>
                {rowOpen ? (
                  <div className="pb-1 pl-2">
                    <ToolCallCard
                      toolCallId={item.toolCallId}
                      capability={item.capability}
                      inputPreview={item.inputPreview}
                      riskLevel={item.riskLevel}
                      status={item.status}
                      output={item.output}
                      stdout={item.stdout}
                      stderr={item.stderr}
                      errorReason={item.errorReason}
                      durationMs={item.durationMs}
                      hideHeader
                    />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
