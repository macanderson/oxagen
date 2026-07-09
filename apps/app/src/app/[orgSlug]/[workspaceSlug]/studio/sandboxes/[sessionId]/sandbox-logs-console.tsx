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
import type { SandboxLogLine } from "@/lib/studio/sandboxes";

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

type Stream = "stdout" | "stderr" | "system";

/** Normalise an unknown stream value to a known tag; unknowns read as stdout. */
function normStream(value: unknown): Stream {
  return value === "stderr" || value === "system" ? value : "stdout";
}

const STREAM_TAG_CLASS: Record<Stream, string> = {
  stdout: "text-neutral-500",
  stderr: "text-error",
  system: "text-neutral-600",
};

function LogLine({ line }: { line: SandboxLogLine }) {
  const stream = normStream(line.stream);
  const text = typeof line.text === "string" ? line.text : String(line.text ?? "");
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
      <span className="min-w-0 flex-1 text-neutral-200">
        {parseAnsiLine(text).map((seg, i) => (
          <span key={i} className={seg.className}>
            {seg.text}
          </span>
        ))}
      </span>
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
      const next = await loadLogs({ level });
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
        "flex flex-col overflow-hidden rounded-xl border border-border bg-black/90",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3 border-b border-white/10 px-3 py-2">
        <span className="font-mono text-xs text-neutral-400">
          logs · {sessionId.length > 14 ? `${sessionId.slice(0, 12)}…` : sessionId}
        </span>
        <div className="flex items-center gap-3">
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-neutral-400">
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
            className="h-7 gap-1 px-2 text-xs text-neutral-300 hover:text-white"
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

      <div
        ref={scrollRef}
        role="log"
        aria-label="Sandbox output logs"
        aria-live="polite"
        className="max-h-[28rem] min-h-[10rem] flex-1 overflow-y-auto overflow-x-auto p-3 font-mono text-xs leading-relaxed"
      >
        {error ? (
          <div role="alert" className="text-error">
            {error}
          </div>
        ) : lines.length === 0 ? (
          <div className="text-neutral-600">
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
