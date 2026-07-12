/**
 * debug-panel.tsx — presentational render of `agent.debug.trace`'s structured
 * failure frame (ADR-021 §3): the failing step, error class/message, parsed
 * top stack frames, related spans, deterministically-ranked suspect files, a
 * bounded error-events sample, and a logs tail.
 *
 * Server-rendered (no "use client") — collapsible sections use native
 * <details>/<summary> rather than client-side state, matching the pattern in
 * chat/registry-components/ci-status-summary.tsx.
 *
 * Never displays a raw UUID as a primary identifier: relatedSpans/suspectFiles
 * already carry human-readable public ids / paths from the handler.
 */
import { AlertTriangle } from "lucide-react";
import type { AgentDebugTraceOutput } from "@oxagen/oxagen/contracts/agent.debug.trace";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { formatDuration, formatTimestamp } from "@/components/activity/format";

export interface DebugPanelProps {
  frame: AgentDebugTraceOutput;
}

function severityBadgeVariant(
  severity: AgentDebugTraceOutput["errorEvents"][number]["severity"],
): BadgeProps["variant"] {
  switch (severity) {
    case "fatal":
      return "destructive";
    case "error":
      return "error";
    default:
      return "warning";
  }
}

export function DebugPanel({ frame }: DebugPanelProps) {
  const failedRelated = frame.relatedSpans.filter((s) => s.status === "failed").length;

  return (
    <Card
      data-testid="run-debug-panel"
      className="border-destructive/40 bg-destructive/5"
    >
      <div className="flex flex-col gap-4 p-4">
        {/* Header — error class, status, bounded message. */}
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <AlertTriangle className="size-4 shrink-0 text-destructive" aria-hidden="true" />
            <span className="text-sm font-semibold text-destructive">
              {frame.errorClass ?? "Execution failed"}
            </span>
            <Badge variant="destructive" size="sm">
              {frame.status}
            </Badge>
          </div>
          {frame.message ? (
            <p className="max-w-full break-words pl-6 text-sm text-destructive/90">
              {frame.message}
            </p>
          ) : null}
        </div>

        {/* Failing step + related-span summary (the closest available "how far
            did this cascade" signal — relatedSpans has no explicit retry
            count, so a failed/total ratio stands in for it). */}
        {frame.failingStep || frame.relatedSpans.length > 0 ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {frame.failingStep ? (
              <span>
                Failing step:{" "}
                <span className="font-medium text-foreground">
                  {frame.failingStep.stepType ?? "unknown"}
                  {frame.failingStep.toolName ? ` · ${frame.failingStep.toolName}` : ""}
                </span>
                {frame.failingStep.latencyMs !== null
                  ? ` (${formatDuration(frame.failingStep.latencyMs)})`
                  : ""}
              </span>
            ) : null}
            {frame.relatedSpans.length > 0 ? (
              <span>
                Related spans:{" "}
                <span className="font-medium text-foreground">
                  {frame.relatedSpans.length}
                </span>
                {failedRelated > 0 ? ` (${failedRelated} failed)` : ""}
              </span>
            ) : null}
          </div>
        ) : null}

        {/* Top stack frames. */}
        {frame.topFrames.length > 0 ? (
          <section>
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Stack frames
            </h3>
            <div className="overflow-x-auto rounded-md border border-border/40 bg-card">
              <ul className="flex flex-col divide-y divide-border/40">
                {frame.topFrames.map((f, i) => (
                  <li
                    key={i}
                    className="flex items-center gap-2 whitespace-nowrap px-2.5 py-1.5 font-mono text-xs"
                  >
                    <span className={f.internal ? "text-muted-foreground" : "text-foreground"}>
                      {f.functionName ?? "<anonymous>"}
                    </span>
                    <span className="text-muted-foreground">
                      {f.file ?? "?"}
                      {f.line !== null ? `:${f.line}` : ""}
                      {f.column !== null ? `:${f.column}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        ) : null}

        {/* Suspect files — deterministically ranked fix sites. */}
        {frame.suspectFiles.length > 0 ? (
          <section>
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Suspect files
            </h3>
            <ul className="flex flex-col gap-1.5">
              {frame.suspectFiles.map((sf) => (
                <li
                  key={sf.path}
                  className="overflow-x-auto rounded-md border border-border/40 bg-card px-2.5 py-1.5 text-xs"
                >
                  <div className="flex items-center gap-2 whitespace-nowrap">
                    <span className="font-mono text-foreground">{sf.path}</span>
                    <Badge variant="muted" size="sm">
                      score {sf.score}
                    </Badge>
                  </div>
                  {sf.reasons.length > 0 ? (
                    <p className="mt-1 whitespace-normal text-muted-foreground">
                      {sf.reasons.join(", ")}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* Error events — bounded sample, collapsed by default. */}
        {frame.errorEvents.length > 0 ? (
          <details className="group">
            <summary className="flex cursor-pointer list-none items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
              <span>Error events ({frame.errorEvents.length})</span>
            </summary>
            <ul className="mt-2 flex flex-col gap-1.5 border-t border-border/40 pt-2">
              {frame.errorEvents.map((ev, i) => (
                <li
                  key={`${ev.fingerprint}-${i}`}
                  className="overflow-x-auto rounded-md border border-border/40 bg-card px-2.5 py-1.5 text-xs"
                >
                  <div className="flex flex-wrap items-center gap-2 whitespace-nowrap">
                    <Badge variant={severityBadgeVariant(ev.severity)} size="sm">
                      {ev.severity}
                    </Badge>
                    <span className="font-mono text-muted-foreground">{ev.source}</span>
                    <span className="text-muted-foreground">{formatTimestamp(ev.createdAt)}</span>
                  </div>
                  <p className="mt-1 whitespace-normal break-words text-foreground">
                    {ev.message}
                  </p>
                </li>
              ))}
            </ul>
          </details>
        ) : null}

        {/* Logs tail — bounded sample, collapsed by default. */}
        {frame.logsSample.length > 0 ? (
          <details className="group">
            <summary className="flex cursor-pointer list-none items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
              <span>Logs ({frame.logsSample.length})</span>
            </summary>
            <div className="mt-2 overflow-x-auto rounded-md border border-border/40 bg-muted/40 p-2">
              <pre className="whitespace-pre text-xs text-foreground">
                {frame.logsSample
                  .map((l) => `[${l.level}] ${formatTimestamp(l.createdAt)} ${l.message}`)
                  .join("\n")}
              </pre>
            </div>
          </details>
        ) : null}
      </div>
    </Card>
  );
}
