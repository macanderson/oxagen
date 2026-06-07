"use client";
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsPanel, TabsList, TabsTab } from "@/components/ui/tabs";
import { StatusIcon } from "./status-icon";
import { formatDuration } from "./tool-call-card";
import type { ToolCallStatus } from "./stream-event-types";
import { lazy, Suspense } from "react";

// Lazy-load the sandboxed iframe renderer so it doesn't bloat the main chunk.
const HtmlArtifact = lazy(
  () => import("@/components/chat/registry-components/artifact-iframe"),
);

/**
 * Heuristic: classify stdout as renderable HTML when the string starts with a
 * recognisable HTML doctype or tag. We avoid a full parse here to keep it fast.
 */
export function looksLikeHtml(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith("<!DOCTYPE html") ||
    trimmed.startsWith("<!doctype html") ||
    trimmed.startsWith("<html") ||
    trimmed.startsWith("<HTML")
  );
}

export interface CodeExecuteCardProps {
  toolCallId: string;
  language: "node" | "python" | "shell" | string;
  code: string;
  status: ToolCallStatus;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  oomKilled?: boolean;
  durationMs?: number;
}

// Specialized variant of `tool-call-card.tsx` for `agent.code.execute`.
// Renders the code block prominently with tabbed stdout/stderr panes and
// a result strip showing exit code + OOM flag. Reuses the same status icon
// language as ToolCallCard so the two read as a family.
export function CodeExecuteCard({
  language,
  code,
  status,
  stdout,
  stderr,
  exitCode,
  oomKilled,
  durationMs,
}: CodeExecuteCardProps) {
  const stdoutRef = React.useRef<HTMLPreElement>(null);
  const stderrRef = React.useRef<HTMLPreElement>(null);
  const [showHtmlPreview, setShowHtmlPreview] = React.useState(false);

  React.useEffect(() => {
    if (status !== "running") return;
    if (stdoutRef.current) stdoutRef.current.scrollTop = stdoutRef.current.scrollHeight;
    if (stderrRef.current) stderrRef.current.scrollTop = stderrRef.current.scrollHeight;
  }, [stdout, stderr, status]);

  const hasHtmlOutput =
    status === "completed" &&
    exitCode === 0 &&
    stdout != null &&
    looksLikeHtml(stdout);

  return (
    <div
      className="rounded-xl border bg-card text-card-foreground shadow my-2 space-y-3 p-3 text-sm animate-in"
      data-component="code-execute-card"
      data-status={status}
    >
      <div className="flex items-center gap-2">
        <Badge variant="outline" className="font-mono">
          agent.code.execute
        </Badge>
        <Badge variant="muted" className="uppercase">
          {language}
        </Badge>
        <StatusIcon status={status} />
        {durationMs != null && status !== "running" ? (
          <span className="ml-auto text-xs text-muted-foreground tabular-nums">
            {formatDuration(durationMs)}
          </span>
        ) : null}
      </div>

      <pre className="overflow-x-auto rounded-lg bg-muted/50 p-3 font-mono text-xs leading-relaxed">
        <code>{code}</code>
      </pre>

      <Tabs defaultValue="stdout">
        <TabsList>
          <TabsTab value="stdout">stdout</TabsTab>
          <TabsTab value="stderr">stderr</TabsTab>
        </TabsList>
        <TabsPanel value="stdout">
          <pre
            ref={stdoutRef}
            className="max-h-64 overflow-y-auto rounded-lg bg-black/85 p-2 font-mono text-xs text-emerald-200"
          >
            {stdout ?? (status === "running" ? "Waiting for output…" : "")}
          </pre>
        </TabsPanel>
        <TabsPanel value="stderr">
          <pre
            ref={stderrRef}
            className="max-h-64 overflow-y-auto rounded-lg bg-black/85 p-2 font-mono text-xs text-rose-300"
          >
            {stderr ?? ""}
          </pre>
        </TabsPanel>
      </Tabs>

      {status !== "running" ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge
            variant={exitCode === 0 ? "success" : "destructive"}
            className="tabular-nums"
          >
            exit {exitCode ?? "?"}
          </Badge>
          {oomKilled ? <Badge variant="destructive">OOM killed</Badge> : null}
          {hasHtmlOutput ? (
            <button
              type="button"
              onClick={() => setShowHtmlPreview((v) => !v)}
              className="ml-auto inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-1 text-xs font-medium text-foreground hover:bg-muted/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-colors"
              aria-expanded={showHtmlPreview}
              aria-label={showHtmlPreview ? "Hide HTML preview" : "Show HTML preview"}
            >
              {showHtmlPreview ? "Hide Preview" : "Preview HTML"}
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Sandboxed HTML artifact preview — only shown when stdout is HTML and user toggled it. */}
      {hasHtmlOutput && showHtmlPreview && stdout != null ? (
        <Suspense
          fallback={
            <div className="h-32 animate-pulse rounded-xl bg-muted" aria-busy="true" aria-label="Loading preview" />
          }
        >
          <HtmlArtifact html={stdout} title={`Output — ${language}`} />
        </Suspense>
      ) : null}
    </div>
  );
}

