/**
 * TerminalPanel — the red-outlined live terminal emulator pinned just above the
 * agent messages in the REPL.
 *
 * When the user runs a `!command`, its stdout/stderr stream into this panel in
 * real time (see shell-runner.ts). It is deliberately visually distinct from the
 * agent transcript — a red border and a `$` shell prompt — so shell output is
 * never confused with the agent speaking, and stays pinned in place while the
 * command runs and the agent keeps posting messages below it.
 *
 * Output is tailed to the last {@link MAX_LINES} lines so a chatty build can't
 * push the input bar off-screen; a header notes how many lines were elided.
 */
import { Box, Text } from "ink";
import React, { useEffect, useState } from "react";

/** Terminal red — the panel's signature outline. */
const TERMINAL_RED = "#F87171";

/** Keep the panel bounded: only the last N output lines are shown. */
const MAX_LINES = 18;

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** A shell command run surfaced in the terminal panel. */
export interface TerminalRun {
  /** Monotonic id — a fresh run replaces the panel's contents. */
  id: number;
  /** The command the user typed after `!`. */
  command: string;
  /** Combined stdout+stderr accumulated so far. */
  output: string;
  status: "running" | "exited" | "killed";
  /** Present once the process exits. */
  exitCode?: number;
  startedAt: number;
  /** Present once the run finishes (exit or kill). */
  endedAt?: number;
}

/** Compact elapsed wall-clock: `12s`, `1m04s`. */
function elapsed(from: number, to: number): string {
  const s = Math.max(0, Math.round((to - from) / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${(s % 60).toString().padStart(2, "0")}s`;
}

/** Header status glyph + label + color for the current run state. */
function statusStyle(
  run: TerminalRun,
  frame: number,
): { glyph: string; label: string; color: string } {
  if (run.status === "running")
    return {
      glyph: SPINNER[frame % SPINNER.length] as string,
      label: "running",
      color: TERMINAL_RED,
    };
  if (run.status === "killed")
    return { glyph: "⏹", label: "killed", color: "#FBBF24" };
  return run.exitCode === 0
    ? { glyph: "✓", label: "exit 0", color: "#34D399" }
    : { glyph: "✗", label: `exit ${run.exitCode ?? 1}`, color: TERMINAL_RED };
}

export function TerminalPanel({
  run,
  nowFn,
  collapsed = false,
}: {
  run: TerminalRun;
  /** Injectable clock for deterministic tests; production uses Date.now. */
  nowFn?: () => number;
  /** Folded accordion form (a finished run parked in the transcript): show only
   *  the header line + an expand hint, hiding the output body. Ctrl-O toggles it. */
  collapsed?: boolean;
}): React.ReactElement {
  const now = nowFn ?? (() => Date.now());
  const [frame, setFrame] = useState(0);
  // Animate the spinner / advance the elapsed timer only while running.
  useEffect(() => {
    if (run.status !== "running") return;
    const id = setInterval(() => setFrame((f) => f + 1), 100);
    return () => clearInterval(id);
  }, [run.status]);

  const at = run.status === "running" ? now() : (run.endedAt ?? now());
  const { glyph, label, color } = statusStyle(run, frame);

  const allLines = run.output.replace(/\n$/, "").split("\n");
  const elided = Math.max(0, allLines.length - MAX_LINES);
  const shown = elided > 0 ? allLines.slice(-MAX_LINES) : allLines;
  const hasOutput = run.output.trim().length > 0;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={TERMINAL_RED}
      paddingX={1}
      marginBottom={1}
    >
      {/* Header — the shell prompt, the command, live status + elapsed. */}
      <Box>
        <Text color={TERMINAL_RED} bold>
          {"$ "}
        </Text>
        <Text bold wrap="truncate-end">
          {run.command}
        </Text>
        <Text>{"  "}</Text>
        <Text color={color} bold>
          {glyph} {label}
        </Text>
        <Text dimColor> · {elapsed(run.startedAt, at)}</Text>
        {collapsed ? (
          <Text dimColor>
            {" · "}
            {allLines.length} line{allLines.length === 1 ? "" : "s"} · Ctrl-O to
            expand
          </Text>
        ) : null}
      </Box>
      {/* Body — the tailed output. Hidden in the folded (collapsed) accordion form. */}
      {collapsed ? null : (
        <Box
          flexDirection="column"
          marginTop={hasOutput || run.status === "running" ? 1 : 0}
        >
          {elided > 0 ? (
            <Text dimColor>
              … {elided} earlier line{elided === 1 ? "" : "s"} hidden
            </Text>
          ) : null}
          {shown.map((line, i) => (
            <Text key={i} wrap="truncate-end">
              {line}
            </Text>
          ))}
          {run.status === "running" && !hasOutput ? (
            <Text dimColor>waiting for output…</Text>
          ) : null}
        </Box>
      )}
    </Box>
  );
}

/** How many output lines the expanded accordion shows before tailing. */
const CARD_MAX_LINES = 40;

/**
 * TerminalRunCard — a FINISHED `!command` folded inline into the chat transcript
 * as a collapsed, expandable accordion.
 *
 * Once a shell command exits, its live red {@link TerminalPanel} disappears (see
 * interactive.tsx's fold timer) and the run reappears here, in chronological
 * order alongside the agent/user messages that surround it. Collapsed it is a
 * single quiet line — command, exit status, elapsed, line count — so scrollback
 * stays skimmable; expanded (Ctrl-O toggles the most recent) it reveals the
 * captured output. Deliberately NOT red: the red outline means "live", and a
 * folded card is history, not a running process.
 */
export function TerminalRunCard({
  run,
  expanded,
}: {
  run: TerminalRun;
  expanded: boolean;
}): React.ReactElement {
  const { glyph, label, color } = statusStyle(run, 0);
  const at = run.endedAt ?? run.startedAt;
  const allLines = run.output.replace(/\n$/, "").split("\n");
  const lineCount = run.output.trim().length === 0 ? 0 : allLines.length;
  const elided = expanded ? Math.max(0, allLines.length - CARD_MAX_LINES) : 0;
  const shown = elided > 0 ? allLines.slice(-CARD_MAX_LINES) : allLines;

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Header — the accordion toggle line. Always one row. */}
      <Box>
        <Text dimColor>{expanded ? "▾ " : "▸ "}</Text>
        <Text dimColor>{"$ "}</Text>
        <Text bold wrap="truncate-end">
          {run.command}
        </Text>
        <Text>{"  "}</Text>
        <Text color={color}>
          {glyph} {label}
        </Text>
        <Text dimColor> · {elapsed(run.startedAt, at)}</Text>
        {lineCount > 0 ? (
          <Text dimColor>
            {" · "}
            {lineCount} line{lineCount === 1 ? "" : "s"}
          </Text>
        ) : null}
      </Box>
      {/* Body — only when expanded. A dim left gutter marks it as shell output. */}
      {expanded && lineCount > 0 ? (
        <Box flexDirection="column" paddingLeft={2}>
          {elided > 0 ? (
            <Text dimColor>
              … {elided} earlier line{elided === 1 ? "" : "s"} hidden
            </Text>
          ) : null}
          {shown.map((line, i) => (
            <Text key={i} dimColor wrap="truncate-end">
              {line}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}
