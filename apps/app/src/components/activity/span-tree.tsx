"use client";

/**
 * span-tree.tsx — collapsible span-tree viewer for one agent run.
 *
 * Renders an agent.trace.get result as a nested, expandable tree:
 *   execution → steps → tool calls, plus child executions (subagent/A2A).
 * Each row shows a status badge, a duration bar (proportional to the root run's
 * wall-clock), and token figures. Selecting any row opens a detail panel with
 * the full field set and (for tool calls) the response preview.
 *
 * Identifier discipline (CLAUDE.md): the primary on-screen id is always the
 * human-prefixed public id (aex_/aes_/atc_) or a tool/step name — never a raw
 * UUID. The only raw UUID (an execution's originId) appears solely in the
 * detail panel as a copyable, truncated secondary field.
 */

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Copy, Check } from "lucide-react";
import type { AgentTraceGetOutput } from "@oxagen/oxagen/contracts/agent.trace.get";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  formatCost,
  formatDuration,
  formatTimestamp,
  formatTokens,
  statusBadgeVariant,
} from "./format";

type Trace = AgentTraceGetOutput;
type StepNode = Trace["steps"][number];
type ToolCallNode = StepNode["toolCalls"][number];

// A flattened description of whatever row is selected, rendered in the panel.
type Selection =
  | { kind: "execution"; node: Trace }
  | { kind: "step"; node: StepNode; executionId: string }
  | { kind: "tool"; node: ToolCallNode; stepId: string };

/** Sum of a node's own latency; used to scale the duration bars. */
function rootDurationMs(trace: Trace): number {
  // Prefer the root latency; fall back to the span between started/completed.
  if (trace.latencyMs && trace.latencyMs > 0) return trace.latencyMs;
  if (trace.startedAt && trace.completedAt) {
    const d = new Date(trace.completedAt).getTime() - new Date(trace.startedAt).getTime();
    if (d > 0) return d;
  }
  return 0;
}

function CopyableId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(id);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground"
      title="Copy id"
    >
      <span className="truncate max-w-[16rem]">{id}</span>
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
    </button>
  );
}

/** Proportional duration bar. */
function DurationBar({ ms, rootMs }: { ms: number | null; rootMs: number }) {
  const pct = ms && rootMs > 0 ? Math.max(2, Math.min(100, (ms / rootMs) * 100)) : 0;
  return (
    <div className="h-1.5 w-full rounded-full bg-muted" aria-hidden>
      <div
        className="h-full rounded-full bg-primary/60"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const variant = statusBadgeVariant(status);
  const color =
    variant === "success"
      ? "bg-success"
      : variant === "error"
        ? "bg-destructive"
        : variant === "warning"
          ? "bg-warning"
          : variant === "info"
            ? "bg-info"
            : "bg-muted-foreground";
  return <span className={`inline-block size-2 shrink-0 rounded-full ${color}`} />;
}

interface RowShellProps {
  depth: number;
  expandable: boolean;
  expanded: boolean;
  onToggle: () => void;
  onSelect: () => void;
  selected: boolean;
  status: string;
  title: React.ReactNode;
  meta: React.ReactNode;
  durationMs: number | null;
  rootMs: number;
}

function RowShell({
  depth,
  expandable,
  expanded,
  onToggle,
  onSelect,
  selected,
  status,
  title,
  meta,
  durationMs,
  rootMs,
}: RowShellProps) {
  return (
    <div
      className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors ${
        selected ? "bg-accent" : "hover:bg-muted/60"
      }`}
      style={{ paddingLeft: `${depth * 1.25 + 0.5}rem` }}
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex size-4 shrink-0 items-center justify-center text-muted-foreground disabled:opacity-0"
        disabled={!expandable}
        aria-label={expanded ? "Collapse" : "Expand"}
      >
        {expandable ? (
          expanded ? (
            <ChevronDown className="size-4" />
          ) : (
            <ChevronRight className="size-4" />
          )
        ) : null}
      </button>
      <StatusDot status={status} />
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <span className="hidden w-40 shrink-0 md:block">
          <DurationBar ms={durationMs} rootMs={rootMs} />
        </span>
        <span className="w-16 shrink-0 text-right font-mono text-xs text-muted-foreground">
          {formatDuration(durationMs)}
        </span>
        <span className="hidden w-40 shrink-0 truncate text-right text-xs text-muted-foreground lg:block">
          {meta}
        </span>
      </button>
    </div>
  );
}

function ToolCallRow({
  tool,
  depth,
  rootMs,
  selection,
  onSelect,
}: {
  tool: ToolCallNode;
  depth: number;
  rootMs: number;
  selection: Selection | null;
  onSelect: (s: Selection) => void;
}) {
  const selected =
    selection?.kind === "tool" && selection.node.toolCallId === tool.toolCallId;
  const tokens = formatTokens(tool.inputTokens, tool.outputTokens);
  return (
    <RowShell
      depth={depth}
      expandable={false}
      expanded={false}
      onToggle={() => {}}
      onSelect={() => onSelect({ kind: "tool", node: tool, stepId: tool.toolCallId })}
      selected={selected}
      status={tool.status}
      durationMs={tool.latencyMs}
      rootMs={rootMs}
      title={
        <span className="flex items-center gap-2">
          <span className="text-muted-foreground">tool</span>
          <span className="font-medium">{tool.toolName}</span>
          <Badge variant="muted" size="sm">
            {tool.toolType}
          </Badge>
        </span>
      }
      meta={tokens ? `${tokens} tok` : ""}
    />
  );
}

function StepRow({
  step,
  depth,
  rootMs,
  expandedKeys,
  toggle,
  selection,
  onSelect,
}: {
  step: StepNode;
  depth: number;
  rootMs: number;
  expandedKeys: Set<string>;
  toggle: (key: string) => void;
  selection: Selection | null;
  onSelect: (s: Selection) => void;
}) {
  const key = `step:${step.stepId}`;
  const expanded = expandedKeys.has(key);
  const selected = selection?.kind === "step" && selection.node.stepId === step.stepId;
  const tokens = formatTokens(step.inputTokens, step.outputTokens);
  return (
    <>
      <RowShell
        depth={depth}
        expandable={step.toolCalls.length > 0}
        expanded={expanded}
        onToggle={() => toggle(key)}
        onSelect={() => onSelect({ kind: "step", node: step, executionId: "" })}
        selected={selected}
        status={step.status}
        durationMs={step.latencyMs}
        rootMs={rootMs}
        title={
          <span className="flex items-center gap-2">
            <span className="text-muted-foreground">step {step.stepNumber}</span>
            <span className="font-medium">{step.stepType}</span>
            {step.toolCalls.length > 0 ? (
              <Badge variant="secondary" size="sm">
                {step.toolCalls.length} tool{step.toolCalls.length === 1 ? "" : "s"}
              </Badge>
            ) : null}
          </span>
        }
        meta={tokens ? `${tokens} tok` : ""}
      />
      {expanded
        ? step.toolCalls.map((tc) => (
            <ToolCallRow
              key={tc.toolCallId}
              tool={tc}
              depth={depth + 1}
              rootMs={rootMs}
              selection={selection}
              onSelect={onSelect}
            />
          ))
        : null}
    </>
  );
}

function ExecutionRow({
  node,
  depth,
  rootMs,
  expandedKeys,
  toggle,
  selection,
  onSelect,
}: {
  node: Trace;
  depth: number;
  rootMs: number;
  expandedKeys: Set<string>;
  toggle: (key: string) => void;
  selection: Selection | null;
  onSelect: (s: Selection) => void;
}) {
  const key = `exec:${node.executionId}`;
  const expanded = expandedKeys.has(key);
  const selected =
    selection?.kind === "execution" && selection.node.executionId === node.executionId;
  const hasChildren = node.steps.length > 0 || node.children.length > 0;
  const tokens = formatTokens(node.inputTokens, node.outputTokens);
  const cost = formatCost(node.estimatedCostUsd);
  return (
    <>
      <RowShell
        depth={depth}
        expandable={hasChildren}
        expanded={expanded}
        onToggle={() => toggle(key)}
        onSelect={() => onSelect({ kind: "execution", node })}
        selected={selected}
        status={node.status}
        durationMs={node.latencyMs}
        rootMs={rootMs}
        title={
          <span className="flex items-center gap-2">
            <Badge variant={statusBadgeVariant(node.status)} size="sm">
              {node.status}
            </Badge>
            <span className="text-muted-foreground">{node.originType}</span>
            <span className="font-mono text-xs">{node.executionId}</span>
          </span>
        }
        meta={[tokens ? `${tokens} tok` : "", cost ?? ""].filter(Boolean).join(" · ")}
      />
      {expanded ? (
        <>
          {node.steps.map((step) => (
            <StepRow
              key={step.stepId}
              step={step}
              depth={depth + 1}
              rootMs={rootMs}
              expandedKeys={expandedKeys}
              toggle={toggle}
              selection={selection}
              onSelect={onSelect}
            />
          ))}
          {node.children.map((child) => (
            <ExecutionRow
              key={child.executionId}
              node={child}
              depth={depth + 1}
              rootMs={rootMs}
              expandedKeys={expandedKeys}
              toggle={toggle}
              selection={selection}
              onSelect={onSelect}
            />
          ))}
        </>
      ) : null}
    </>
  );
}

function DetailField({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className="text-sm break-words">{value}</span>
    </div>
  );
}

function DetailPanel({ selection }: { selection: Selection | null }) {
  if (!selection) {
    return (
      <p className="text-sm text-muted-foreground">
        Select a span to inspect its full detail.
      </p>
    );
  }
  if (selection.kind === "execution") {
    const n = selection.node;
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Badge variant={statusBadgeVariant(n.status)} size="sm">
            {n.status}
          </Badge>
          <span className="text-sm font-medium">execution</span>
        </div>
        <DetailField label="Execution ID" value={<CopyableId id={n.executionId} />} />
        <DetailField label="Origin" value={n.originType} />
        <DetailField label="Origin ID" value={<CopyableId id={n.originId} />} />
        {n.agentId ? (
          <DetailField label="Agent" value={<CopyableId id={n.agentId} />} />
        ) : null}
        <Separator />
        <DetailField label="Duration" value={formatDuration(n.latencyMs)} />
        <DetailField
          label="Tokens"
          value={formatTokens(n.inputTokens, n.outputTokens) || "—"}
        />
        <DetailField label="Est. cost" value={formatCost(n.estimatedCostUsd) ?? "—"} />
        <DetailField
          label="Started"
          value={n.startedAt ? formatTimestamp(n.startedAt) : "—"}
        />
        <DetailField
          label="Completed"
          value={n.completedAt ? formatTimestamp(n.completedAt) : "—"}
        />
        {n.failureReason ? (
          <DetailField
            label="Failure"
            value={<span className="text-destructive">{n.failureReason}</span>}
          />
        ) : null}
        {n.turnMetrics && n.turnMetrics.length > 0 ? (
          <>
            <Separator />
            <div className="flex items-center justify-between">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">
                Turn metrics
              </span>
              <Badge
                variant={n.replayDeterministic ? "success" : "warning"}
                size="sm"
              >
                {n.replayDeterministic ? "deterministic" : "non-deterministic"}
              </Badge>
            </div>
            <div className="flex flex-col gap-1.5">
              {n.turnMetrics.map((t) => (
                <div
                  key={t.turnId}
                  className="flex items-center justify-between rounded-md bg-muted/40 px-2 py-1 text-xs"
                >
                  <span className="font-mono text-muted-foreground">{t.turnId}</span>
                  <span className="text-right">
                    {t.compileMs}ms · {t.tokens} tok · {t.toolCalls} tool
                    {t.toolCalls === 1 ? "" : "s"} · {t.outcome}
                  </span>
                </div>
              ))}
            </div>
          </>
        ) : null}
      </div>
    );
  }
  if (selection.kind === "step") {
    const s = selection.node;
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Badge variant={statusBadgeVariant(s.status)} size="sm">
            {s.status}
          </Badge>
          <span className="text-sm font-medium">step {s.stepNumber}</span>
        </div>
        <DetailField label="Step ID" value={<CopyableId id={s.stepId} />} />
        <DetailField label="Type" value={s.stepType} />
        <Separator />
        <DetailField label="Duration" value={formatDuration(s.latencyMs)} />
        <DetailField
          label="Tokens"
          value={formatTokens(s.inputTokens, s.outputTokens) || "—"}
        />
        <DetailField
          label="Started"
          value={s.startedAt ? formatTimestamp(s.startedAt) : "—"}
        />
        <DetailField
          label="Completed"
          value={s.completedAt ? formatTimestamp(s.completedAt) : "—"}
        />
        {s.failureReason ? (
          <DetailField
            label="Failure"
            value={<span className="text-destructive">{s.failureReason}</span>}
          />
        ) : null}
      </div>
    );
  }
  const t = selection.node;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Badge variant={statusBadgeVariant(t.status)} size="sm">
          {t.status}
        </Badge>
        <span className="text-sm font-medium">{t.toolName}</span>
      </div>
      <DetailField label="Tool call ID" value={<CopyableId id={t.toolCallId} />} />
      <DetailField label="Type" value={t.toolType} />
      <Separator />
      <DetailField label="Duration" value={formatDuration(t.latencyMs)} />
      <DetailField
        label="Tokens"
        value={formatTokens(t.inputTokens, t.outputTokens) || "—"}
      />
      <DetailField label="Request size" value={`${t.requestBytes} B`} />
      <DetailField label="Response size" value={`${t.responseBytes} B`} />
      {t.responsePreview ? (
        <DetailField
          label="Response preview"
          value={
            <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2 text-xs">
              {t.responsePreview}
            </pre>
          }
        />
      ) : null}
    </div>
  );
}

export function SpanTree({ trace }: { trace: Trace }) {
  const rootMs = useMemo(() => rootDurationMs(trace), [trace]);

  // Default-expand the root and its immediate steps for an at-a-glance view.
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => {
    const s = new Set<string>();
    s.add(`exec:${trace.executionId}`);
    for (const step of trace.steps) s.add(`step:${step.stepId}`);
    return s;
  });
  const [selection, setSelection] = useState<Selection | null>({
    kind: "execution",
    node: trace,
  });

  function toggle(key: string) {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div
      className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_20rem]"
      data-testid="run-span-tree"
    >
      <div className="min-w-0 rounded-lg border bg-card p-2">
        <div className="flex items-center gap-2 px-2 pb-2 text-xs uppercase tracking-wide text-muted-foreground">
          <span className="min-w-0 flex-1">Span</span>
          <span className="hidden w-40 shrink-0 md:block">Duration</span>
          <span className="w-16 shrink-0 text-right">Time</span>
          <span className="hidden w-40 shrink-0 text-right lg:block">Tokens / cost</span>
        </div>
        <Separator className="mb-1" />
        <ExecutionRow
          node={trace}
          depth={0}
          rootMs={rootMs}
          expandedKeys={expandedKeys}
          toggle={toggle}
          selection={selection}
          onSelect={setSelection}
        />
      </div>
      <aside className="lg:sticky lg:top-4 lg:self-start">
        <div className="rounded-lg border bg-card p-4">
          <h2 className="mb-3 text-sm font-semibold">Detail</h2>
          <DetailPanel selection={selection} />
        </div>
      </aside>
    </div>
  );
}
