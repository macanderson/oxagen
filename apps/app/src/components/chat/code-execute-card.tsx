"use client";
import * as React from "react";
import { ChevronRight } from "lucide-react";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import { Tabs, TabsPanel, TabsList, TabsTab } from "@/components/ui/tabs";
import { transition } from "@oxagen/ui/lib/motion";
import { cn } from "@/lib/utils";
import { HeaderStatus, formatDuration } from "./tool-call-card";
import { toolCallMeta } from "./tool-call-meta";
// Shared GitHub light/dark palette — same surface as the terminal & trace card.
import "@/components/chat/registry-components/code-surface.css";
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
  /** Not read by this component — accepted so callers can pass the whole live
   *  tool-call record through without stripping the id first. */
  toolCallId: string;
  language: "node" | "python" | "shell" | string;
  code: string;
  status: ToolCallStatus;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  oomKilled?: boolean;
  durationMs?: number;
  defaultOpen?: boolean;
}

// Specialized variant of `tool-call-card.tsx` for the `execute_code` capability.
// Same quiet contract as ToolCallCard: the card is COLLAPSED by default — a
// single muted header row (label, language, status, duration) — because the
// executed code and its stdout/stderr are tool-call input/output, and tool I/O
// never renders expanded in the conversation. Expanding reveals the code block,
// tabbed stdout/stderr panes and a result strip with exit code + OOM flag.
export function CodeExecuteCard({
  language,
  code,
  status,
  stdout,
  stderr,
  exitCode,
  oomKilled,
  durationMs,
  defaultOpen = false,
}: CodeExecuteCardProps) {
  const reducedMotion = useReducedMotion();
  const [open, setOpen] = React.useState(defaultOpen);
  const stdoutRef = React.useRef<HTMLPreElement>(null);
  const stderrRef = React.useRef<HTMLPreElement>(null);
  const [showHtmlPreview, setShowHtmlPreview] = React.useState(false);

  // Auto-scroll the output panes while running; `open` is a dependency so
  // expanding mid-run lands at the latest output, not the top of the buffer.
  React.useEffect(() => {
    if (status !== "running" || !open) return;
    if (stdoutRef.current)
      stdoutRef.current.scrollTop = stdoutRef.current.scrollHeight;
    if (stderrRef.current)
      stderrRef.current.scrollTop = stderrRef.current.scrollHeight;
  }, [stdout, stderr, status, open]);

  const hasHtmlOutput =
    status === "completed" &&
    exitCode === 0 &&
    stdout != null &&
    looksLikeHtml(stdout);

  // Same compact header language as ToolCallCard: icon + human label; the raw
  // capability string only appears in the `title` attribute and data attrs.
  const { label, Icon } = toolCallMeta("execute_code");

  return (
    <div
      className="rounded-lg border bg-card text-card-foreground my-1 overflow-hidden p-0 text-sm animate-in"
      data-component="code-execute-card"
      data-capability="execute_code"
      data-status={status}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={
          open ? "Collapse code run details" : "Expand code run details"
        }
        title="execute_code"
        className="flex min-h-9 w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-muted/40"
      >
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-muted-foreground/70 transition-transform",
            open && "rotate-90",
          )}
          aria-hidden="true"
        />
        <Icon
          className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <span className="truncate text-xs font-medium">{label}</span>
        <span className="text-xs uppercase text-muted-foreground">
          {language}
        </span>
        <span className="ml-auto flex items-center gap-2">
          <HeaderStatus status={status} />
          {durationMs != null && status !== "running" ? (
            <span className="text-xs text-muted-foreground tabular-nums">
              {formatDuration(durationMs)}
            </span>
          ) : null}
        </span>
      </button>

      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            key="code-execute-body"
            initial={reducedMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
            animate={
              reducedMotion ? { opacity: 1 } : { height: "auto", opacity: 1 }
            }
            exit={reducedMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={transition.base}
            style={{ overflow: "hidden" }}
          >
            <div className="space-y-2 border-t px-3 py-2.5">
              <pre className="code-surface overflow-x-auto rounded-lg p-3 font-mono text-xs leading-relaxed">
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
                    className="code-surface-bare max-h-48 overflow-y-auto rounded-lg p-2.5 font-mono text-xs leading-relaxed text-success"
                  >
                    {stdout ??
                      (status === "running" ? "Waiting for output…" : "")}
                  </pre>
                </TabsPanel>
                <TabsPanel value="stderr">
                  <pre
                    ref={stderrRef}
                    className="code-surface-bare max-h-48 overflow-y-auto rounded-lg p-2.5 font-mono text-xs leading-relaxed text-error"
                  >
                    {stderr ?? ""}
                  </pre>
                </TabsPanel>
              </Tabs>

              {status !== "running" ? (
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium tabular-nums",
                      exitCode === 0
                        ? "bg-success/15 text-success"
                        : "bg-destructive/15 text-destructive",
                    )}
                  >
                    exit {exitCode ?? "?"}
                  </span>
                  {oomKilled ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-medium text-destructive">
                      OOM killed
                    </span>
                  ) : null}
                  {hasHtmlOutput ? (
                    <button
                      type="button"
                      onClick={() => setShowHtmlPreview((v) => !v)}
                      className="ml-auto inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-expanded={showHtmlPreview}
                      aria-label={
                        showHtmlPreview
                          ? "Hide HTML preview"
                          : "Show HTML preview"
                      }
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
                    <div
                      className="h-32 animate-pulse rounded-xl bg-muted"
                      aria-busy="true"
                      aria-label="Loading preview"
                    />
                  }
                >
                  <HtmlArtifact html={stdout} title={`Output — ${language}`} />
                </Suspense>
              ) : null}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
