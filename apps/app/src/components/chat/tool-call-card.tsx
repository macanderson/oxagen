"use client";
import * as React from "react";
import { Check, ChevronDown, ChevronRight, Loader2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { RiskBadge } from "./risk-badge";
import type { RiskLevel, ToolCallStatus } from "./stream-event-types";

export interface ToolCallCardProps {
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
  defaultOpen?: boolean;
}

export function ToolCallCard(props: ToolCallCardProps) {
  const {
    capability,
    inputPreview,
    riskLevel,
    status,
    output,
    stdout,
    stderr,
    errorReason,
    durationMs,
    defaultOpen = false,
  } = props;
  const [open, setOpen] = React.useState(defaultOpen);
  const streamRef = React.useRef<HTMLDivElement>(null);

  // Auto-scroll the output pane to the bottom while the call is running.
  // Freeze on terminal state so the user can scroll back through history.
  React.useEffect(() => {
    if (status !== "running") return;
    if (!streamRef.current) return;
    streamRef.current.scrollTop = streamRef.current.scrollHeight;
  }, [stdout, stderr, status]);

  return (
    <div className="glass-panel my-2 overflow-hidden p-0 text-sm animate-in">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        <Badge variant="outline" className="font-mono">
          {capability}
        </Badge>
        <RiskBadge risk={riskLevel} />
        <StatusIcon status={status} />
        {durationMs != null && status !== "running" ? (
          <span className="ml-auto text-xs text-muted-foreground tabular-nums">
            {formatDuration(durationMs)}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="space-y-3 border-t border-[color:var(--glass-border)] px-3 py-3">
          <Section label="Input">
            <pre className="overflow-x-auto rounded-lg bg-muted/40 p-2 font-mono text-xs">
              {safeJson(inputPreview)}
            </pre>
          </Section>
          {(stdout || stderr || status === "running") && (
            <Section label="Output stream">
              <div
                ref={streamRef}
                className="max-h-64 overflow-y-auto rounded-lg bg-black/85 p-2 font-mono text-xs text-emerald-200"
              >
                {stdout ? <pre className="whitespace-pre-wrap">{stdout}</pre> : null}
                {stderr ? (
                  <pre className="whitespace-pre-wrap text-rose-300">{stderr}</pre>
                ) : null}
                {status === "running" && !stdout && !stderr ? (
                  <span className="text-muted-foreground">Waiting for output…</span>
                ) : null}
              </div>
            </Section>
          )}
          {output !== undefined && status === "completed" ? (
            <Section label="Result">
              <pre className="overflow-x-auto rounded-lg bg-muted/40 p-2 font-mono text-xs">
                {safeJson(output)}
              </pre>
            </Section>
          ) : null}
          {status === "failed" && errorReason ? (
            <Section label="Error">
              <p className="text-xs text-destructive">{errorReason}</p>
            </Section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function StatusIcon({ status }: { status: ToolCallStatus }) {
  if (status === "running") {
    return <Loader2 className={cn("h-3.5 w-3.5 animate-spin text-accent")} aria-label="Running" />;
  }
  if (status === "completed") {
    return <Check className="h-3.5 w-3.5 text-emerald-500" aria-label="Completed" />;
  }
  return <X className="h-3.5 w-3.5 text-destructive" aria-label="Failed" />;
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      {children}
    </div>
  );
}

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}
