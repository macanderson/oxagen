"use client";

/**
 * CodingTracePanel — a right-side collapsible rail summarizing the active
 * turn as ordered stages, mirroring the CLI's `StageKind` pipeline model
 * (`apps/cli/src/agent/trace.ts` → `@oxagen/agent-engine`'s
 * evaluate/plan/enhance/route/execute/judge/revise/complete). The chat UI's
 * live turn already has its own richer event vocabulary (tool calls, code
 * runs, subagent fanouts) than the engine's coarse pipeline stages, so this
 * panel groups THAT vocabulary into five reader-facing buckets in the same
 * spirit as the CLI's stage rail: Plan → Tool calls → Code runs → Subagents →
 * Result.
 *
 * Pure client composition over `useToolStream` state — no new stream events,
 * no engine changes. Every row is a deep link (`#turn-entry-<key>`) to the
 * matching inline card already rendered in the transcript by
 * `chat-shell-client.tsx`'s `renderEntry`/`timelineEntries` (the anchor ids
 * are stamped onto each `<TimelineItem>` there). Clicking a row scrolls the
 * transcript to that card via the browser's native fragment-navigation.
 *
 * Collapsed by default on narrow layouts; the caller decides whether to
 * render the rail at all (e.g. hidden in the floating embedded chat panel).
 */

import * as React from "react";
import {
  ChevronRight,
  ListTodo,
  Wrench,
  Terminal,
  Users,
  CheckCircle2,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { LiveFanout, LivePlan, LiveToolCall } from "./use-tool-stream";
import type { TurnUsage } from "./stream-event-types";

// ---------------------------------------------------------------------------
// Stage model
// ---------------------------------------------------------------------------

/** The five reader-facing stage buckets, always rendered in this order. */
const STAGE_ORDER = ["plan", "tool", "code", "subagent", "result"] as const;
export type CodingTraceStage = (typeof STAGE_ORDER)[number];

const STAGE_META: Record<
  CodingTraceStage,
  { label: string; Icon: React.ComponentType<{ className?: string }> }
> = {
  plan: { label: "Plan", Icon: ListTodo },
  tool: { label: "Tool calls", Icon: Wrench },
  code: { label: "Code runs", Icon: Terminal },
  subagent: { label: "Subagents", Icon: Users },
  result: { label: "Result", Icon: CheckCircle2 },
};

export type CodingTraceTone =
  | "thinking"
  | "running"
  | "done"
  | "failed"
  | "idle";

export interface CodingTraceRow {
  /** The `order` timeline key this row was derived from (or a synthetic id
   *  for the "Result" row, which has no discrete timeline entry). */
  key: string;
  label: string;
  tone: CodingTraceTone;
  active: boolean;
  /** Anchor id (without the leading `#`) of the matching inline card, or
   *  undefined when there is nothing to deep-link to yet. */
  anchorId?: string;
}

/**
 * Capabilities that read as "running code" rather than a generic tool call —
 * everything else observed in `toolCalls` falls into the generic "Tool
 * calls" bucket. Mirrors the code-run affordances already special-cased in
 * `chat-shell-client.tsx` (`execute_code` → `CodeExecuteCard`) plus the
 * durable-sandbox and repo-mutation surface. (ADR-025: verb-first snake_case
 * names have no shared dotted prefix, so the family is an explicit set.)
 */
const CODE_RUN_CAPABILITIES = new Set<string>([
  "execute_code",
  // durable sandbox family
  "start_sandbox",
  "run_sandbox_command",
  "snapshot_sandbox",
  "stop_sandbox",
  "list_sandbox_files",
  "read_sandbox_file",
  // repo-mutation surface
  "open_pr",
  "get_pr",
  "get_pr_diff",
  "get_ci_status",
  "create_branch",
  "create_repo",
  "fork_repo",
  "sync_repo",
  "put_repo_file",
  "get_repo_metrics",
  "configure_repo",
  "pause_repo",
  "resume_repo",
  "edit_repo_file",
]);

export function isCodeRunCapability(capability: string): boolean {
  return CODE_RUN_CAPABILITIES.has(capability);
}

/** Split an `order` timeline key (`"<kind>:<id>"`) into its parts. */
function splitKey(key: string): { kind: string; id: string } {
  const sep = key.indexOf(":");
  return { kind: key.slice(0, sep), id: key.slice(sep + 1) };
}

function toneForToolCall(status: LiveToolCall["status"]): CodingTraceTone {
  if (status === "completed") return "done";
  if (status === "failed") return "failed";
  return "running";
}

function toneForFanout(status: LiveFanout["status"]): CodingTraceTone {
  if (status === "completed") return "done";
  if (status === "running") return "running";
  return "failed";
}

/**
 * Groups the live turn's `order`-walked timeline into the five stage
 * buckets. Exported (pure, no React) so it's unit-testable without mounting
 * the component.
 */
export function groupCodingTraceStages({
  order,
  plans,
  toolCalls,
  activeFanouts,
  turnUsage,
  isStreaming,
}: {
  order: string[];
  plans: Record<string, LivePlan>;
  toolCalls: Record<string, LiveToolCall>;
  activeFanouts: Record<string, LiveFanout>;
  turnUsage: TurnUsage | undefined;
  isStreaming: boolean;
}): Record<CodingTraceStage, CodingTraceRow[]> {
  const groups: Record<CodingTraceStage, CodingTraceRow[]> = {
    plan: [],
    tool: [],
    code: [],
    subagent: [],
    result: [],
  };

  for (const key of order) {
    const { kind, id } = splitKey(key);
    if (kind === "plan") {
      const p = plans[id];
      if (!p) continue;
      groups.plan.push({
        key,
        label: p.title || "Plan",
        tone: p.status === "pending" ? "running" : "done",
        active: p.status === "pending",
        anchorId: `turn-entry-${key}`,
      });
    } else if (kind === "tool") {
      const tc = toolCalls[id];
      if (!tc) continue;
      const row: CodingTraceRow = {
        key,
        label: tc.capability,
        tone: toneForToolCall(tc.status),
        active: tc.status === "pending" || tc.status === "running",
        anchorId: `turn-entry-${key}`,
      };
      if (isCodeRunCapability(tc.capability)) groups.code.push(row);
      else groups.tool.push(row);
    } else if (kind === "fanout") {
      const f = activeFanouts[id];
      if (!f) continue;
      const count = f.children.length;
      groups.subagent.push({
        key,
        label: `${count} subagent${count === 1 ? "" : "s"}`,
        tone: toneForFanout(f.status),
        active: f.status === "running",
        anchorId: `turn-entry-${key}`,
      });
    }
  }

  if (turnUsage !== undefined) {
    groups.result.push({
      key: "result",
      label: "Turn complete",
      tone: "done",
      active: false,
      anchorId: "turn-result",
    });
  } else if (isStreaming) {
    groups.result.push({
      key: "result-pending",
      label: "In progress…",
      tone: "running",
      active: true,
    });
  }

  return groups;
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

const dotToneClass: Record<CodingTraceTone, string> = {
  thinking: "bg-info",
  running: "bg-info animate-pulse",
  done: "bg-success",
  failed: "bg-destructive",
  idle: "bg-muted-foreground/40",
};

function TraceRowLink({ row }: { row: CodingTraceRow }) {
  const content = (
    <>
      <span
        className={cn("size-1.5 shrink-0 rounded-full", dotToneClass[row.tone])}
        aria-hidden="true"
      />
      <span
        className="min-w-0 flex-1 truncate font-mono text-[11px]"
        title={row.label}
      >
        {row.label}
      </span>
    </>
  );
  const rowClass =
    "flex min-h-8 w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs text-foreground";

  if (!row.anchorId) {
    return (
      <li>
        <div className={cn(rowClass, "text-muted-foreground")}>{content}</div>
      </li>
    );
  }
  return (
    <li>
      <a
        href={`#${row.anchorId}`}
        className={cn(
          rowClass,
          "hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
        data-testid={`trace-row-${row.key}`}
      >
        {content}
      </a>
    </li>
  );
}

function StageSection({
  stage,
  rows,
}: {
  stage: CodingTraceStage;
  rows: CodingTraceRow[];
}) {
  const [open, setOpen] = React.useState(true);
  if (rows.length === 0) return null;
  const { label, Icon } = STAGE_META[stage];
  const anyActive = rows.some((r) => r.active);

  return (
    <div data-testid={`trace-stage-${stage}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex min-h-8 w-full items-center gap-1.5 rounded-md px-1 py-1 text-left hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRight
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
          aria-hidden="true"
        />
        <Icon
          className="size-3.5 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <span className="flex-1 truncate text-xs font-semibold">{label}</span>
        {anyActive ? (
          <span
            className="size-1.5 shrink-0 rounded-full bg-info animate-pulse"
            aria-hidden="true"
          />
        ) : null}
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {rows.length}
        </span>
      </button>
      {open ? (
        <ul className="ml-4 border-l border-border/60 pl-1">
          {rows.map((row) => (
            <TraceRowLink key={row.key} row={row} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * The chrome-less stage list — `STAGE_ORDER` rendered as collapsible
 * `StageSection`s over a precomputed `groups` map. Split out of
 * `CodingTracePanel` so the calm Agent-activity rail can drop the same stage
 * list into its own "Progress" card without the panel's border / collapse-all
 * header (which would double up with the card's own chrome).
 */
export function CodingTraceStages({
  groups,
}: {
  groups: Record<CodingTraceStage, CodingTraceRow[]>;
}) {
  return (
    // Marker lives on the shared stages list (not the CodingTracePanel wrapper)
    // so both the registry panel and the AgentActivityRail's ProgressCard —
    // which renders these stages directly — expose the same anchor.
    <div data-component="coding-trace-panel" className="flex flex-col gap-1">
      {STAGE_ORDER.map((stage) => (
        <StageSection key={stage} stage={stage} rows={groups[stage]} />
      ))}
    </div>
  );
}

export interface CodingTracePanelProps {
  order: string[];
  plans: Record<string, LivePlan>;
  toolCalls: Record<string, LiveToolCall>;
  activeFanouts: Record<string, LiveFanout>;
  turnUsage: TurnUsage | undefined;
  isStreaming: boolean;
  className?: string;
  /** Initial collapsed state of the whole rail. Default false (expanded). */
  defaultCollapsed?: boolean;
}

export function CodingTracePanel({
  order,
  plans,
  toolCalls,
  activeFanouts,
  turnUsage,
  isStreaming,
  className,
  defaultCollapsed = false,
}: CodingTracePanelProps) {
  const [collapsed, setCollapsed] = React.useState(defaultCollapsed);
  const groups = React.useMemo(
    () =>
      groupCodingTraceStages({
        order,
        plans,
        toolCalls,
        activeFanouts,
        turnUsage,
        isStreaming,
      }),
    [order, plans, toolCalls, activeFanouts, turnUsage, isStreaming],
  );
  const totalRows = STAGE_ORDER.reduce(
    (sum, stage) => sum + groups[stage].length,
    0,
  );

  if (totalRows === 0) return null;

  return (
    // The marker lives on the inner CodingTraceStages below, not here, so it
    // doesn't render twice.
    <div
      className={cn(
        "flex flex-col gap-1 rounded-xl border border-border bg-card p-2 text-card-foreground shadow-sm",
        collapsed ? "w-11" : "w-64",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-1">
        {!collapsed ? (
          <span className="px-1 text-xs font-semibold">Turn trace</span>
        ) : null}
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          aria-label={collapsed ? "Expand turn trace" : "Collapse turn trace"}
          aria-expanded={!collapsed}
          className="ml-auto inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {collapsed ? (
            <PanelRightOpen className="size-4" aria-hidden="true" />
          ) : (
            <PanelRightClose className="size-4" aria-hidden="true" />
          )}
        </button>
      </div>
      {!collapsed ? <CodingTraceStages groups={groups} /> : null}
    </div>
  );
}
