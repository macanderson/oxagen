"use client";
import * as React from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { RiskBadge } from "./risk-badge";
import { StatusIcon } from "./status-icon";
import { StructuredField } from "./structured-value";
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
    <div
      className="rounded-xl border bg-card text-card-foreground shadow my-2 overflow-hidden p-0 text-sm animate-in"
      data-component="tool-call-card"
      data-capability={capability}
      data-status={status}
      data-testid={`tool-call-card-${props.toolCallId}`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={open ? "Collapse tool call details" : "Expand tool call details"}
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
        <div className="space-y-3 border-t px-3 py-3">
          {/* While the model is still streaming the call's arguments the input
              is an unparsed partial — show a clean composing indicator rather
              than raw partial JSON. Once parsed it renders as a typed tree. */}
          {status === "pending" ? (
            <div className="space-y-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Input
              </span>
              <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                Composing arguments…
              </div>
            </div>
          ) : (
            <StructuredField label="Input" value={inputPreview} />
          )}
          {(stdout || stderr || status === "running") && (
            <Section label="Output stream">
              <div
                ref={streamRef}
                className="max-h-64 overflow-y-auto rounded-lg bg-black/85 p-2 font-mono text-xs text-success"
              >
                {stdout ? <pre className="whitespace-pre-wrap">{stdout}</pre> : null}
                {stderr ? (
                  <pre className="whitespace-pre-wrap text-error">{stderr}</pre>
                ) : null}
                {status === "running" && !stdout && !stderr ? (
                  <span className="text-muted-foreground">Waiting for output…</span>
                ) : null}
              </div>
            </Section>
          )}
          {output !== undefined && status === "completed" ? (
            <StructuredField label="Result" value={output} />
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
