"use client";

/**
 * sandbox-logs-console.tsx — the captured-output console for one durable
 * sandbox session.
 *
 * Renders the session's output log as a scrollback, each line tagged with its
 * stream (`[stdout]` / `[stderr]` / `[system]`) and coloured via the shared
 * `parseAnsiLine` ANSI→tailwind mapper so it reads identically to the terminal
 * and trace card. A Debug toggle controls verbosity: OFF requests
 * `level: "normal"` (program output only); ON omits the level so the capability
 * returns everything (command echoes, timings, lifecycle notes). A live-tail
 * poll refreshes every few seconds, pausing while the tab is hidden, and a
 * Refresh button forces an immediate reload.
 *
 * `loadLogs` is INJECTED (like SandboxTerminal's `runCommand`) so this stays
 * pure UI: the detail page binds it to the `list_sandbox_logs` server action,
 * while tests pass a mock and assert the `level` it flips to.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  parseAnsiLine,
} from "@/components/chat/registry-components/terminal-trace-card";
// Shared GitHub light/dark palette — same surface as the terminal & trace card.
import "@/components/chat/registry-components/code-surface.css";
import type { SandboxLogLine } from "@/lib/workbench/sandboxes";

/** Injected loader — the page binds this to a `list_sandbox_logs` action. */
export type LoadLogsFn = (opts: {
  level?: "normal" | "debug";
  limit?: number;
}) => Promise<SandboxLogLine[]>;

export interface SandboxLogsConsoleProps {
  sessionId: string;
  loadLogs: LoadLogsFn;
  /** Disable loading + polling (e.g. session stopped / no manage rights). */
  disabled?: boolean;
  /** Live-tail poll interval in ms (default 3000). */
  pollMs?: number;
  className?: string;
}

const DEFAULT_POLL_MS = 3000;

// Cap the scrollback fetched per poll — a hard upper bound on rows rendered
// (unvirtualized), so a long-running session can't grow the DOM unboundedly.
const SANDBOX_LOGS_LIMIT = 500;

type Stream = "stdout" | "stderr" | "system";

/** Normalise an unknown stream value to a known tag; unknowns read as stdout. */
function normStream(value: unknown): Stream {
  return value === "stderr" || value === "system" ? value : "stdout";
}

const STREAM_TAG_CLASS: Record<Stream, string> = {
  stdout: "code-fg-muted",
  stderr: "text-error",
  system: "code-fg-faint",
};

/** Compact, NaN-safe ms formatter for the system-line duration suffix. */
function formatMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

function LogLine({ line }: { line: SandboxLogLine }) {
  const stream = normStream(line.stream);
  // The captured text is `line.line` (the previous `line.text` never existed at
  // runtime, so every row rendered blank).
  const text = typeof line.line === "string" ? line.line : "";
  // The `system` line that closes a command carries its exit code + duration as
  // separate columns — surface them as a compact suffix instead of dropping
  // them, and never render a bare NaN when a field is absent.
  const dur = formatMs(line.durationMs);
  const meta =
    stream === "system"
      ? [line.exitCode != null ? `exit ${line.exitCode}` : "", dur]
          .filter(Boolean)
          .join(" · ")
      : "";
  return (
    <div
      data-testid="sandbox-logs-line"
      data-stream={stream}
      className={cn(
        "flex gap-2 whitespace-pre-wrap break-words",
        stream === "system" && "opacity-70",
      )}
    >
      <span className={cn("shrink-0 select-none", STREAM_TAG_CLASS[stream])}>
        [{stream}]
      </span>
      <span className="code-fg min-w-0 flex-1">
        {parseAnsiLine(text).map((seg, i) => (
          <span key={i} className={seg.className}>
            {seg.text}
          </span>
        ))}
      </span>
      {meta ? (
        <span className="code-fg-faint shrink-0 select-none tabular-nums">{meta}</span>
      ) : null}
    </div>
  );
}

export function SandboxLogsConsole({
  sessionId,
  loadLogs,
  disabled = false,
  pollMs = DEFAULT_POLL_MS,
  className,
}: SandboxLogsConsoleProps) {
  const [debug, setDebug] = useState(false);
  const [lines, setLines] = useState<SandboxLogLine[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Debug OFF → program output only ("normal"); ON → omit level for everything.
  const level: "normal" | undefined = debug ? undefined : "normal";

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await loadLogs({ level, limit: SANDBOX_LOGS_LIMIT });
      setLines(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load logs.");
    } finally {
      setLoading(false);
    }
  }, [loadLogs, level]);

  // Load on mount and whenever the level flips, and arm the live-tail poll.
  // `refresh` changes identity with `level`, so toggling Debug both reloads
  // immediately and re-arms the interval with the new verbosity.
  useEffect(() => {
    if (disabled) return;
    void refresh();
    const id = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void refresh();
    }, pollMs);
    return () => clearInterval(id);
  }, [refresh, disabled, pollMs]);

  // Keep the newest output in view.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <div
      data-testid="sandbox-logs-console"
      className={cn(
        "code-surface flex flex-col overflow-hidden rounded-xl border",
        className,
      )}
    >
      <div className="code-border flex items-center justify-between gap-3 border-b px-3 py-2">
        <span className="code-fg-muted font-mono text-xs">
          logs · {sessionId.length > 14 ? `${sessionId.slice(0, 12)}…` : sessionId}
        </span>
        <div className="flex items-center gap-3">
          <label className="code-fg-muted flex cursor-pointer items-center gap-1.5 text-xs">
            <Switch
              data-testid="sandbox-logs-debug-toggle"
              checked={debug}
              onCheckedChange={(checked) => setDebug(checked === true)}
              disabled={disabled}
              aria-label="Toggle debug log verbosity"
            />
            Debug
          </label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="code-fg-muted h-7 gap-1 px-2 text-xs"
            onClick={() => void refresh()}
            disabled={disabled || loading}
            data-testid="sandbox-logs-refresh"
          >
            <RefreshCw
              className={cn("h-3.5 w-3.5", loading && "animate-spin")}
              aria-hidden
            />
            Refresh
          </Button>
        </div>
      </div>

      {/* A transient poll failure with lines already loaded shows a compact
          banner ABOVE the scrollback rather than blowing it away — and sits
          outside the auto-scrolling log so live-tail can't scroll it off. */}
      {error && lines.length > 0 ? (
        <div
          role="alert"
          className="code-border text-error border-b px-3 py-1.5 text-xs"
        >
          {error}
        </div>
      ) : null}

      <div
        ref={scrollRef}
        role="log"
        aria-label="Sandbox output logs"
        aria-live="polite"
        className="max-h-[28rem] min-h-[10rem] flex-1 overflow-y-auto overflow-x-auto p-3 font-mono text-xs leading-relaxed"
      >
        {error && lines.length === 0 ? (
          <div role="alert" className="text-error">
            {error}
          </div>
        ) : lines.length === 0 ? (
          <div className="code-fg-faint">
            {disabled
              ? "Logs are unavailable for this sandbox."
              : loading
                ? "Loading logs…"
                : "No output captured yet."}
          </div>
        ) : (
          lines.map((line, i) => <LogLine key={i} line={line} />)
        )}
      </div>
    </div>
  );
}

export default SandboxLogsConsole;
