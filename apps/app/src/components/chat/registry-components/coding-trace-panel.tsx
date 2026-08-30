"use client";

import { useState, type ReactElement } from "react";
import {
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  XCircle,
  Loader2,
  ListTree,
} from "lucide-react";
import { formatDuration } from "../tool-call-card";
import TerminalTraceCard, {
  type TerminalTraceCardProps,
} from "./terminal-trace-card";
import CodeDiffCard, { type CodeDiffCardProps } from "./code-diff-card";

/**
 * coding-trace-panel — collapsible run-overview panel that stitches together
 * the per-step artifact cards (terminal scrollback, unified diffs) a coding
 * agent produces over the course of one turn into a single timeline. It is a
 * pure composition layer: rendering of each step's body is fully delegated to
 * `TerminalTraceCard` / `CodeDiffCard` — this component only supplies the
 * step list, ordering, and the overall run summary (count, total duration,
 * status), so there is exactly one implementation of terminal/diff rendering
 * in the tree.
 *
 * componentId: "coding-trace-panel"
 */

export interface CodingTraceStep {
  kind: "terminal" | "diff";
  /** Short label for this step's row (e.g. "Run tests", "Apply patch"). */
  title?: string;
  status?: "success" | "error" | "running";
  durationMs?: number;
  terminal?: TerminalTraceCardProps;
  diff?: CodeDiffCardProps;
}

export interface CodingTracePanelProps {
  steps: CodingTraceStep[];
  title?: string;
}

type OverallStatus = "success" | "error" | "running";

function overallStatus(steps: CodingTraceStep[]): OverallStatus {
  if (steps.some((s) => s.status === "error")) return "error";
  if (steps.some((s) => s.status === "running")) return "running";
  return "success";
}

const STATUS_ICON: Record<OverallStatus, ReactElement> = {
  success: <CheckCircle2 className="size-4 text-success" aria-hidden="true" />,
  error: <XCircle className="size-4 text-error" aria-hidden="true" />,
  running: (
    <Loader2 className="size-4 animate-spin text-primary" aria-hidden="true" />
  ),
};

const STEP_STATUS_ICON: Record<
  NonNullable<CodingTraceStep["status"]>,
  ReactElement
> = {
  success: (
    <CheckCircle2
      className="size-3.5 shrink-0 text-success"
      aria-hidden="true"
    />
  ),
  error: (
    <XCircle className="size-3.5 shrink-0 text-error" aria-hidden="true" />
  ),
  running: (
    <Loader2
      className="size-3.5 shrink-0 animate-spin text-primary"
      aria-hidden="true"
    />
  ),
};

function StepRow({ step, index }: { step: CodingTraceStep; index: number }) {
  return (
    <div
      className="border-b border-border/60 px-4 py-3 last:border-b-0"
      data-step-kind={step.kind}
    >
      <div className="mb-2 flex items-center gap-2">
        {step.status ? STEP_STATUS_ICON[step.status] : null}
        <span className="text-xs font-medium text-foreground">
          {step.title ?? `Step ${index + 1}`}
        </span>
        <span className="text-xs text-muted-foreground">{step.kind}</span>
        {step.durationMs !== undefined ? (
          <span className="ml-auto text-xs text-muted-foreground tabular-nums">
            {formatDuration(step.durationMs)}
          </span>
        ) : null}
      </div>
      {step.kind === "terminal" && step.terminal ? (
        <TerminalTraceCard {...step.terminal} />
      ) : null}
      {step.kind === "diff" && step.diff ? (
        <CodeDiffCard {...step.diff} />
      ) : null}
    </div>
  );
}

export default function CodingTracePanel({
  steps,
  title,
}: CodingTracePanelProps): ReactElement {
  const [open, setOpen] = useState(false);

  if (steps.length === 0) {
    return (
      <div
        className="my-2 rounded-xl border border-border bg-card px-4 py-3 text-sm text-muted-foreground"
        data-component="coding-trace-panel"
      >
        No steps.
      </div>
    );
  }

  const totalDurationMs = steps.reduce(
    (sum, s) => sum + (s.durationMs ?? 0),
    0,
  );
  const status = overallStatus(steps);

  return (
    <div
      className="my-2 overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-sm"
      data-component="coding-trace-panel"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ListTree
          className="size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <span className="text-sm font-semibold">{title ?? "Coding run"}</span>
        {STATUS_ICON[status]}
        <span className="text-xs text-muted-foreground">
          {steps.length} step{steps.length === 1 ? "" : "s"}
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {formatDuration(totalDurationMs)}
        </span>
        {open ? (
          <ChevronDown
            className="ml-auto size-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
        ) : (
          <ChevronRight
            className="ml-auto size-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
        )}
      </button>
      {open ? (
        <div>
          {steps.map((step, i) => (
            <StepRow key={i} step={step} index={i} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
