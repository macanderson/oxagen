"use client";
import * as React from "react";
import { Check, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { cn, formatDuration } from "@/lib/utils";
import { JsonSnippet } from "./json-snippet";
import { StructuredField } from "./structured-value";
import { toolCallMeta } from "./tool-call-meta";
import type { RiskLevel, ToolCallStatus } from "./stream-event-types";

/**
 * Graph query results are big, machine-shaped documents — node and edge hits
 * carrying full property bags — and the structured chip/grid tree turns them
 * into an unreadable wall. These capabilities render their Result as a clipped,
 * syntax-highlighted JSON snippet with a copy button instead.
 */
const JSON_RESULT_CAPS = new Set([
  "search_graph",
  "query_ontology",
  "get_ontology_neighbors",
  "search_nodes",
  "get_graph_stats",
]);

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
  /**
   * When true the collapsible header is omitted and the detail body renders
   * on its own — used by ToolActivityGroup, where the compact activity row
   * above already acts as the header. The card still carries its
   * `tool-call-card-<id>` test id for e2e continuity.
   */
  hideHeader?: boolean;
}

/**
 * A quiet, muted status glyph for the header row. Deliberately restrained:
 * tool calls happen constantly, so a completed call shows only a faint check
 * and a failed call a neutral dot + muted "failed" — never a red badge or X
 * screaming for attention in the conversation history. Shared with
 * CodeExecuteCard so both collapsed headers read as one family.
 */
export function HeaderStatus({ status }: { status: ToolCallStatus }) {
  if (status === "pending") {
    return (
      <span
        className="inline-block h-2 w-2 animate-pulse rounded-full bg-muted-foreground/60"
        aria-label="Composing"
      />
    );
  }
  if (status === "running") {
    return (
      <Loader2
        className="h-3.5 w-3.5 animate-spin text-muted-foreground"
        aria-label="Running"
      />
    );
  }
  if (status === "completed") {
    return (
      <Check
        className="h-3.5 w-3.5 text-muted-foreground"
        aria-label="Completed"
      />
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 text-xs text-muted-foreground"
      aria-label="Failed"
    >
      <span
        className="inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground/70"
        aria-hidden="true"
      />
      failed
    </span>
  );
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
    hideHeader = false,
  } = props;
  const [openState, setOpen] = React.useState(defaultOpen);
  // Headerless bodies are always open — the enclosing row owns the toggle.
  const open = hideHeader ? true : openState;
  const streamRef = React.useRef<HTMLDivElement>(null);

  // Auto-scroll the output pane to the bottom while the call is running.
  // Freeze on terminal state so the user can scroll back through history.
  React.useEffect(() => {
    if (status !== "running") return;
    if (!streamRef.current) return;
    streamRef.current.scrollTop = streamRef.current.scrollHeight;
  }, [stdout, stderr, status]);

  // Human-readable label + domain icon — the raw capability string is never the
  // primary label; it lives in the expanded body and `title` only.
  const { label, Icon } = toolCallMeta(capability);

  // Input + Result sit side-by-side on wide screens so we use horizontal space
  // instead of stacking two full-width definition lists.
  const showResult = output !== undefined && status === "completed";
  const showInput = status !== "pending";
  // Graph-query results stack full-width as a plain JSON snippet — squeezing a
  // large document into a half-width column defeats the point.
  const jsonResult = JSON_RESULT_CAPS.has(capability);

  return (
    <div
      className="rounded-lg border bg-card text-card-foreground my-1 overflow-hidden p-0 text-sm animate-in"
      data-component="tool-call-card"
      data-capability={capability}
      data-status={status}
      data-testid={`tool-call-card-${props.toolCallId}`}
    >
      {hideHeader ? null : (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={openState}
          aria-label={
            openState
              ? "Collapse tool call details"
              : "Expand tool call details"
          }
          title={capability}
          className="flex min-h-9 w-full items-center gap-2 px-3 py-1.5 text-left"
        >
          {openState ? (
            <ChevronDown
              className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
          ) : (
            <ChevronRight
              className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
          )}
          <Icon
            className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <span className="truncate text-xs font-medium">{label}</span>
          <span className="ml-auto flex items-center gap-2">
            <HeaderStatus status={status} />
            {durationMs != null && status !== "running" ? (
              <span className="text-xs text-muted-foreground tabular-nums">
                {formatDuration(durationMs)}
              </span>
            ) : null}
          </span>
        </button>
      )}
      {open ? (
        <div
          className={cn(
            "@container space-y-2 px-3 py-2",
            !hideHeader && "border-t",
          )}
        >
          {/* Raw capability + risk detail belong in the detail body, not the
              collapsed row — the row stays calm and human-readable. */}
          <div className="flex items-center gap-2 font-mono text-[10px] text-muted-foreground">
            <span>{capability}</span>
            <span aria-hidden="true">·</span>
            <span className="uppercase tracking-wide">{riskLevel} risk</span>
          </div>
          {showInput && showResult && jsonResult ? (
            <>
              <StructuredField label="Input" value={inputPreview} />
              <Section label="Result">
                <JsonSnippet value={output} />
              </Section>
            </>
          ) : showInput && showResult ? (
            // Side-by-side only when the CARD itself is wide (container query,
            // not viewport): the chat column is often ~350-500px even on a
            // desktop viewport, and half of that squeezes value columns to
            // zero width (invisible pills — the chat-tool-io e2e regression).
            <div className="grid gap-2 @2xl:grid-cols-2">
              <StructuredField label="Input" value={inputPreview} />
              <StructuredField label="Result" value={output} />
            </div>
          ) : (
            <>
              {/* While the model is still streaming the call's arguments the
                  input is an unparsed partial — show a clean composing
                  indicator rather than raw partial JSON. Once parsed it renders
                  as a typed tree. */}
              {status === "pending" ? (
                <div className="space-y-1.5">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Input
                  </span>
                  <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground">
                    <Loader2
                      className="size-3.5 animate-spin"
                      aria-hidden="true"
                    />
                    Composing arguments…
                  </div>
                </div>
              ) : (
                <StructuredField label="Input" value={inputPreview} />
              )}
              {showResult ? (
                jsonResult ? (
                  <Section label="Result">
                    <JsonSnippet value={output} />
                  </Section>
                ) : (
                  <StructuredField label="Result" value={output} />
                )
              ) : null}
            </>
          )}
          {(stdout || stderr || status === "running") && (
            <Section label="Output stream">
              <div
                ref={streamRef}
                className="max-h-48 overflow-y-auto rounded-lg bg-black/85 p-2 font-mono text-xs text-success"
              >
                {stdout ? (
                  <pre className="whitespace-pre-wrap">{stdout}</pre>
                ) : null}
                {stderr ? (
                  <pre className="whitespace-pre-wrap text-error">{stderr}</pre>
                ) : null}
                {status === "running" && !stdout && !stderr ? (
                  <span className="text-muted-foreground">
                    Waiting for output…
                  </span>
                ) : null}
              </div>
            </Section>
          )}
          {status === "failed" && errorReason ? (
            <Section label="Error">
              {/* The error message body is the one place destructive color is
                  allowed — the section label above stays muted. */}
              <p className="text-xs text-destructive">{errorReason}</p>
            </Section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
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

// Canonical implementation lives in @/lib/utils; re-exported here because the
// chat surface's consumers (and their module mocks in tests) import it from
// this module.
export { formatDuration };
