"use client";

import { useMemo, useState, type ReactElement } from "react";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { formatDuration } from "../tool-call-card";

/**
 * terminal-trace-card — long-form scrollback renderer for `agent.sandbox.exec`
 * (and other shell-execution capabilities) output that is too large for the
 * inline `code-execute-card`. capability-meta's `resolveRenderDirective`
 * routes an execution result here once combined stdout+stderr exceeds
 * `LINE_COLLAPSE_THRESHOLD` lines; short output stays on `code-execute-card`.
 *
 * componentId: "terminal-trace"
 */

export interface TerminalTraceCardProps {
  /** Shell command line, when known (not always available — see capability-meta). */
  command?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  durationMs?: number;
  timedOut?: boolean;
}

const LINE_COLLAPSE_THRESHOLD = 40;

const ANSI_SEQ_RE = /\x1b\[([0-9;]*)([A-Za-z])/g;

const ANSI_COLOR_CLASS: Readonly<Record<string, string>> = {
  "30": "text-neutral-500",
  "31": "text-error",
  "32": "text-success",
  "33": "text-warning",
  "34": "text-info",
  "35": "text-fuchsia-400",
  "36": "text-cyan-400",
  "37": "text-neutral-200",
  "90": "text-neutral-500",
  "91": "text-error",
  "92": "text-success",
  "93": "text-warning",
  "94": "text-info",
  "95": "text-fuchsia-300",
  "96": "text-cyan-300",
  "97": "text-white",
};

export interface AnsiSegment {
  text: string;
  className?: string;
}

/**
 * Hand-rolled, deliberately partial ANSI handler: applies foreground-color
 * (30-37/90-97) and bold (1) SGR codes as tailwind classes, resets on code 0,
 * and silently drops every other escape sequence (cursor moves, clears,
 * backgrounds) rather than leaking raw escape bytes into the DOM. This is the
 * "basic" handling called for — a full terminal emulator is out of scope for
 * a chat scrollback card.
 */
export function parseAnsiLine(line: string): AnsiSegment[] {
  const segments: AnsiSegment[] = [];
  let lastIndex = 0;
  let currentClass: string | undefined;
  ANSI_SEQ_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = ANSI_SEQ_RE.exec(line)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ text: line.slice(lastIndex, match.index), className: currentClass });
    }
    const [, codeStr, letter] = match;
    if (letter === "m") {
      const codes = codeStr && codeStr.length > 0 ? codeStr.split(";") : ["0"];
      for (const code of codes) {
        if (code === "0" || code === "") currentClass = undefined;
        else if (code === "1") currentClass = [currentClass, "font-semibold"].filter(Boolean).join(" ");
        else if (ANSI_COLOR_CLASS[code]) currentClass = ANSI_COLOR_CLASS[code];
      }
    }
    // Non-SGR sequences (cursor movement, screen clears, …) are dropped.
    lastIndex = ANSI_SEQ_RE.lastIndex;
  }
  if (lastIndex < line.length) {
    segments.push({ text: line.slice(lastIndex), className: currentClass });
  }
  return segments.length > 0 ? segments : [{ text: line }];
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  return text.split("\n");
}

function Scrollback({ text, testId }: { text: string; testId: string }) {
  const [expanded, setExpanded] = useState(false);
  const lines = useMemo(() => splitLines(text), [text]);
  const overLimit = lines.length > LINE_COLLAPSE_THRESHOLD;
  const visible = expanded || !overLimit ? lines : lines.slice(0, LINE_COLLAPSE_THRESHOLD);

  if (lines.length === 0) {
    return <p className="px-3 py-3 text-xs text-muted-foreground">(empty)</p>;
  }

  return (
    <div>
      <pre
        data-testid={testId}
        className="max-h-96 overflow-y-auto overflow-x-auto rounded-lg bg-black/90 p-3 font-mono text-xs leading-relaxed text-neutral-200"
      >
        {visible.map((line, i) => (
          <div key={i} className="whitespace-pre">
            {parseAnsiLine(line).map((seg, si) => (
              <span key={si} className={seg.className}>
                {seg.text}
              </span>
            ))}
          </div>
        ))}
      </pre>
      {overLimit ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1.5 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {expanded ? "Show fewer lines" : `Show ${lines.length - LINE_COLLAPSE_THRESHOLD} more lines`}
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
  timedOut,
}: TerminalTraceCardProps): ReactElement {
  const stdoutText = stdout ?? "";
  const stderrText = stderr ?? "";
  const defaultTab = stdoutText.length === 0 && stderrText.length > 0 ? "stderr" : "stdout";

  return (
    <div
      className="my-2 overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-sm"
      data-component="terminal-trace-card"
      data-status={exitCode === 0 ? "success" : "failed"}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-4 py-2.5">
        <Badge variant="outline" className="font-mono">
          terminal
        </Badge>
        {exitCode !== undefined && exitCode !== null ? (
          <Badge variant={exitCode === 0 ? "success" : "destructive"} className="tabular-nums">
            exit {exitCode}
          </Badge>
        ) : null}
        {timedOut ? <Badge variant="destructive">Timed out</Badge> : null}
        {durationMs !== undefined ? (
          <span className="ml-auto text-xs text-muted-foreground tabular-nums">
            {formatDuration(durationMs)}
          </span>
        ) : null}
      </div>

      {command ? (
        <pre className="overflow-x-auto border-b border-border/60 bg-muted/40 px-3 py-2 font-mono text-xs text-foreground">
          $ {command}
        </pre>
      ) : null}

      <div className="p-3">
        <Tabs defaultValue={defaultTab}>
          <TabsList>
            <TabsTab value="stdout">stdout</TabsTab>
            <TabsTab value="stderr">stderr</TabsTab>
          </TabsList>
          <TabsPanel value="stdout">
            <Scrollback text={stdoutText} testId="terminal-trace-stdout" />
          </TabsPanel>
          <TabsPanel value="stderr">
            <Scrollback text={stderrText} testId="terminal-trace-stderr" />
          </TabsPanel>
        </Tabs>
      </div>
    </div>
  );
}
