"use client";

/**
 * sandbox-terminal.tsx — an interactive terminal emulator for a durable sandbox.
 *
 * Unlike the read-only `terminal-trace-card` (which renders one captured
 * `agent.sandbox.exec` blob inside a chat message), this is a live REPL: type a
 * command, it runs in the session via the injected `runCommand`, and the
 * stdout/stderr/exit-code append to a scrollback. This is the "see the agent's
 * CLI" surface — the same shell an agent drives, operated by a human — as
 * opposed to the in-app interactive chat agent.
 *
 * `runCommand` is INJECTED (not a hard dependency on a server action) so this
 * component is pure UI: the sandbox detail page wires it to a
 * `run_sandbox_command` server action, while Storybook and tests pass a mock.
 *
 * It is not a PTY — there is no cursor addressing or live streaming; each entry
 * is one command→response round-trip, which is exactly what
 * `agent.sandbox.exec` provides. ANSI colouring reuses `parseAnsiLine` from the
 * trace card so the two surfaces render output identically.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { cn } from "@/lib/utils";
import { parseAnsiLine } from "@/components/chat/registry-components/terminal-trace-card";

/** Result of one command, minus the command text (the caller supplies that). */
export interface SandboxExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  executionMs: number;
  timedOut: boolean;
  restored?: boolean;
}

/** Injected runner — the page binds this to a `run_sandbox_command` action. */
export type RunCommandFn = (command: string) => Promise<SandboxExecResult>;

/** A completed (or in-flight) scrollback entry. */
export interface TerminalEntry extends Partial<SandboxExecResult> {
  command: string;
  status: "running" | "done" | "error";
}

export interface SandboxTerminalProps {
  /** Durable-session id (sbx_…) — shown in the prompt, not otherwise used here. */
  sessionId: string;
  runCommand: RunCommandFn;
  /** Pre-seed the scrollback (e.g. a warm-up command's output). */
  initialHistory?: TerminalEntry[];
  /** Disable input (e.g. session stopped, or viewer lacks manage rights). */
  disabled?: boolean;
  /** Line shown above the first prompt. */
  welcome?: string;
  className?: string;
}

function AnsiLines({ text }: { text: string }) {
  const lines = useMemo(
    () => (text.length === 0 ? [] : text.split("\n")),
    [text],
  );
  return (
    <>
      {lines.map((line, i) => (
        <div key={i} className="whitespace-pre-wrap break-words">
          {parseAnsiLine(line).map((seg, si) => (
            <span key={si} className={seg.className}>
              {seg.text}
            </span>
          ))}
        </div>
      ))}
    </>
  );
}

function ExitTag({ entry }: { entry: TerminalEntry }) {
  if (entry.status === "running") {
    return <span className="text-neutral-500">running…</span>;
  }
  if (entry.status === "error") {
    return <span className="text-error">error</span>;
  }
  const code = entry.exitCode ?? 0;
  return (
    <span className={code === 0 ? "text-success" : "text-error"}>
      exit {code}
      {entry.timedOut ? " · timed out" : ""}
      {entry.restored ? " · restored" : ""}
      {typeof entry.executionMs === "number"
        ? ` · ${entry.executionMs}ms`
        : ""}
    </span>
  );
}

export function SandboxTerminal({
  sessionId,
  runCommand,
  initialHistory = [],
  disabled = false,
  welcome,
  className,
}: SandboxTerminalProps) {
  const [entries, setEntries] = useState<TerminalEntry[]>(initialHistory);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  // Command history navigation (↑/↓), most-recent last.
  const [historyIdx, setHistoryIdx] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const commandHistory = useMemo(
    () => entries.map((e) => e.command).filter((c) => c.length > 0),
    [entries],
  );

  // Keep the newest output in view.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries]);

  const submit = useCallback(async () => {
    const command = input.trim();
    if (command.length === 0 || busy || disabled) return;
    setInput("");
    setHistoryIdx(null);
    setBusy(true);
    setEntries((prev) => [...prev, { command, status: "running" }]);
    try {
      const result = await runCommand(command);
      setEntries((prev) => {
        const next = [...prev];
        // Update the last (running) entry for this command.
        for (let i = next.length - 1; i >= 0; i--) {
          if (next[i]?.status === "running") {
            next[i] = { command, status: "done", ...result };
            break;
          }
        }
        return next;
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Command failed to run.";
      setEntries((prev) => {
        const next = [...prev];
        for (let i = next.length - 1; i >= 0; i--) {
          if (next[i]?.status === "running") {
            next[i] = {
              command,
              status: "error",
              stdout: "",
              stderr: message,
              exitCode: -1,
              executionMs: 0,
              timedOut: false,
            };
            break;
          }
        }
        return next;
      });
    } finally {
      setBusy(false);
    }
  }, [input, busy, disabled, runCommand]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void submit();
        return;
      }
      if (e.key === "ArrowUp") {
        if (commandHistory.length === 0) return;
        e.preventDefault();
        const idx =
          historyIdx === null
            ? commandHistory.length - 1
            : Math.max(0, historyIdx - 1);
        setHistoryIdx(idx);
        setInput(commandHistory[idx] ?? "");
        return;
      }
      if (e.key === "ArrowDown") {
        if (historyIdx === null) return;
        e.preventDefault();
        const idx = historyIdx + 1;
        if (idx >= commandHistory.length) {
          setHistoryIdx(null);
          setInput("");
        } else {
          setHistoryIdx(idx);
          setInput(commandHistory[idx] ?? "");
        }
      }
    },
    [submit, commandHistory, historyIdx],
  );

  const shortId = sessionId.length > 14 ? `${sessionId.slice(0, 12)}…` : sessionId;

  return (
    <div
      className={cn(
        "flex flex-col overflow-hidden rounded-xl border border-border bg-black/90",
        className,
      )}
    >
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
        <span className="font-mono text-xs text-neutral-400">
          terminal · {shortId}
        </span>
        {busy ? (
          <span className="font-mono text-xs text-warning">working…</span>
        ) : null}
      </div>

      <div
        ref={scrollRef}
        role="log"
        aria-label="Sandbox terminal output"
        aria-live="polite"
        data-testid="sandbox-terminal-scrollback"
        className="max-h-[28rem] min-h-[12rem] flex-1 overflow-y-auto overflow-x-auto p-3 font-mono text-xs leading-relaxed text-neutral-200"
      >
        {welcome ? (
          <div className="mb-2 whitespace-pre-wrap text-neutral-500">
            {welcome}
          </div>
        ) : null}

        {entries.length === 0 && !welcome ? (
          <div className="text-neutral-600">
            Type a command and press Enter to run it in this sandbox.
          </div>
        ) : null}

        {entries.map((entry, i) => (
          <div key={i} className="mb-2">
            <div className="flex items-baseline gap-2">
              <span className="shrink-0 text-success">$</span>
              <span className="whitespace-pre-wrap break-words text-neutral-100">
                {entry.command}
              </span>
            </div>
            {entry.stdout ? <AnsiLines text={entry.stdout} /> : null}
            {entry.stderr ? (
              <div className="text-error">
                <AnsiLines text={entry.stderr} />
              </div>
            ) : null}
            <div className="mt-0.5 text-[10px] uppercase tracking-wide">
              <ExitTag entry={entry} />
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2 border-t border-white/10 px-3 py-2">
        <span className="shrink-0 font-mono text-xs text-success">$</span>
        <input
          type="text"
          value={input}
          disabled={disabled || busy}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label="Sandbox command input"
          data-testid="sandbox-terminal-input"
          placeholder={
            disabled ? "Sandbox not runnable" : "e.g. ls -la  ·  git status"
          }
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          className={cn(
            "flex-1 bg-transparent font-mono text-xs text-neutral-100 placeholder:text-neutral-600",
            "focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60",
          )}
        />
      </div>
    </div>
  );
}

export default SandboxTerminal;
