"use client";

import * as React from "react";
import { TerminalSquare } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { formatDuration } from "../tool-call-card";

/**
 * terminal-trace-card — renders long-running shell output from
 * agent.sandbox.exec / agent.code.execute as a scrollable, ANSI-aware
 * terminal scrollback instead of a raw stdout/stderr JSON blob.
 *
 * componentId: "terminal-trace"
 */

export interface TerminalTraceCardProps {
  command?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  durationMs?: number;
}

/** Lines beyond this count are hidden behind a "Show all" expander. */
const MAX_VISIBLE_LINES = 40;

export interface AnsiSegment {
  text: string;
  className: string;
}

// Minimal SGR (Select Graphic Rendition) foreground-color table — enough to
// render the common case (colored build/test output) without a dependency.
// Codes we don't recognise (cursor movement, screen clear, etc.) are matched
// by the general escape regex below and silently stripped rather than shown
// as garbage control characters.
const ANSI_FG_CLASS: Readonly<Record<number, string>> = {
  30: "text-neutral-900 dark:text-neutral-400",
  31: "text-red-600 dark:text-red-400",
  32: "text-green-600 dark:text-green-400",
  33: "text-yellow-600 dark:text-yellow-400",
  34: "text-blue-600 dark:text-blue-400",
  35: "text-purple-600 dark:text-purple-400",
  36: "text-cyan-600 dark:text-cyan-400",
  37: "text-neutral-300",
  90: "text-neutral-500",
  91: "text-red-400",
  92: "text-green-400",
  93: "text-yellow-400",
  94: "text-blue-400",
  95: "text-purple-400",
  96: "text-cyan-400",
  97: "text-white",
};

// Matches either an SGR sequence (`\x1b[…m`, capture group 1 holds the
// numeric codes) or any other CSI escape sequence (cursor movement, erase,
// etc. — capture group 1 is undefined for these, so callers can tell them
// apart and just drop the latter).
const ANSI_ESCAPE_RE = /\x1b\[([0-9;]*)m|\x1b\[[0-9;]*[A-Za-z]/g;

/**
 * Hand-rolled minimal ANSI SGR parser. Walks the raw string, applies/clears
 * foreground-color + bold state at each SGR escape, and emits plain-text
 * segments carrying the currently active Tailwind class. Any other escape
 * sequence (cursor control, screen clear, …) is stripped with no visual
 * effect — this is a "make coloured CLI output readable" renderer, not a
 * full terminal emulator.
 */
export function parseAnsi(input: string): AnsiSegment[] {
  const segments: AnsiSegment[] = [];
  let lastIndex = 0;
  let classes: string[] = [];
  ANSI_ESCAPE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ANSI_ESCAPE_RE.exec(input)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ text: input.slice(lastIndex, match.index), className: classes.join(" ") });
    }
    const sgrCodes = match[1];
    if (sgrCodes !== undefined) {
      const codes = sgrCodes.length > 0 ? sgrCodes.split(";").map(Number) : [0];
      for (const code of codes) {
        if (code === 0) {
          classes = [];
        } else if (code === 1) {
          if (!classes.includes("font-semibold")) classes.push("font-semibold");
        } else if (code === 39) {
          classes = classes.filter((c) => !c.startsWith("text-"));
        } else if (ANSI_FG_CLASS[code] !== undefined) {
          classes = classes.filter((c) => !c.startsWith("text-"));
          classes.push(ANSI_FG_CLASS[code] as string);
        }
      }
    }
    // else: an unsupported CSI sequence (cursor/erase/etc.) — stripped, no style change.
    lastIndex = ANSI_ESCAPE_RE.lastIndex;
  }
  if (lastIndex < input.length) {
    segments.push({ text: input.slice(lastIndex), className: classes.join(" ") });
  }
  return segments;
}

/**
 * Parse ANSI over the whole string (so color state persists across line
 * breaks, matching real terminal behaviour) then split into per-line segment
 * arrays for rendering + line-count-based truncation.
 */
export function ansiToLines(input: string): AnsiSegment[][] {
  const flat = parseAnsi(input);
  const lines: AnsiSegment[][] = [[]];
  for (const seg of flat) {
    const parts = seg.text.split("\n");
    parts.forEach((part, idx) => {
      if (idx > 0) lines.push([]);
      if (part.length > 0) {
        lines[lines.length - 1]?.push({ text: part, className: seg.className });
      }
    });
  }
  return lines;
}

function Scrollback({ text, emptyLabel }: { text: string; emptyLabel: string }) {
  const [expanded, setExpanded] = React.useState(false);
  const lines = React.useMemo(() => ansiToLines(text), [text]);
  const isEmpty = lines.length === 0 || (lines.length === 1 && lines[0]?.length === 0);

  if (isEmpty) {
    return <p className="px-2 py-1.5 text-xs text-muted-foreground">{emptyLabel}</p>;
  }

  const truncated = !expanded && lines.length > MAX_VISIBLE_LINES;
  const shown = truncated ? lines.slice(0, MAX_VISIBLE_LINES) : lines;

  return (
    <div>
      <pre className="max-h-96 overflow-y-auto rounded-lg bg-black/90 p-2 font-mono text-xs leading-relaxed text-neutral-200">
        {shown.map((segments, li) => (
          <div key={li}>
            {segments.length === 0 ? (
              " "
            ) : (
              segments.map((seg, si) => (
                <span key={si} className={seg.className || undefined}>
                  {seg.text}
                </span>
              ))
            )}
          </div>
        ))}
      </pre>
      {truncated ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-1 text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Show all {lines.length} lines
        </button>
      ) : null}
    </div>
  );
}

export default function TerminalTraceCard({
  command,
  stdout,
  stderr,
  exitCode,
  durationMs,
}: TerminalTraceCardProps) {
  const defaultTab = !stdout && stderr ? "stderr" : "stdout";

  return (
    <div
      className="my-2 space-y-2 rounded-xl border bg-card p-3 text-sm text-card-foreground shadow"
      data-component="terminal-trace-card"
    >
      <div className="flex flex-wrap items-center gap-2">
        <TerminalSquare className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="text-xs font-semibold text-foreground">Terminal output</span>
        {exitCode !== undefined ? (
          <Badge variant={exitCode === 0 ? "success" : "destructive"} className="tabular-nums">
            exit {exitCode}
          </Badge>
        ) : null}
        {durationMs !== undefined ? (
          <span className="ml-auto text-xs text-muted-foreground tabular-nums">
            {formatDuration(durationMs)}
          </span>
        ) : null}
      </div>

      {command ? (
        <pre className="overflow-x-auto rounded-lg bg-muted/50 p-2 font-mono text-xs">
          <code>$ {command}</code>
        </pre>
      ) : null}

      <Tabs defaultValue={defaultTab}>
        <TabsList>
          <TabsTab value="stdout">stdout</TabsTab>
          <TabsTab value="stderr">stderr</TabsTab>
        </TabsList>
        <TabsPanel value="stdout">
          <Scrollback text={stdout ?? ""} emptyLabel="No stdout." />
        </TabsPanel>
        <TabsPanel value="stderr">
          <Scrollback text={stderr ?? ""} emptyLabel="No stderr." />
        </TabsPanel>
      </Tabs>
    </div>
  );
}
