"use client";

/**
 * sandbox-terminal.tsx — an interactive terminal emulator for a durable sandbox.
 *
 * Unlike the read-only `terminal-trace-card` (which renders one captured
 * `agent.sandbox.exec` blob inside a chat message), this is a live REPL: type a
 * command, it runs in the session via the injected `runCommand`, and the
 * stdout/stderr/exit-code append to a scrollback. This is the "see the agent's
 * CLI" surface — the same shell an agent drives, operated by a human.
 *
 * `runCommand` is INJECTED (not a hard dependency on a server action) so this
 * component is pure UI: the sandbox detail page wires it to a
 * `run_sandbox_command` server action, while Storybook and tests pass a mock.
 *
 * It behaves like a real terminal, not a form:
 * - the input is NEVER disabled while a command runs — a disabled input drops
 *   keyboard focus, so the cursor vanishes the moment you press Enter; it is
 *   disabled only when the whole session is unrunnable (`disabled` prop);
 * - Enter while a command is in flight QUEUES the next command (FIFO) — it is
 *   rendered immediately as a `queued` line and runs when the current one ends;
 * - focus is retained: autofocus on mount, refocus when a command completes,
 *   and a click anywhere on the console focuses the input (unless the user is
 *   selecting text to copy).
 *
 * It is not a PTY — there is no cursor addressing or live streaming; each entry
 * is one command→response round-trip, which is exactly what
 * `run_sandbox_command` provides. ANSI colouring reuses `parseAnsiLine` from the
 * trace card; the palette is this surface's own (see sandbox-terminal.css).
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
// This surface's own dark-console theme (NOT chat's shared code-surface).
import "./sandbox-terminal.css";

/** Result of one command, minus the command text (the caller supplies that). */
export interface SandboxExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  executionMs: number;
  timedOut: boolean;
  restored?: boolean;
  /**
   * Working directory AFTER the command ran. The terminal holds this in state
   * and threads it into the next command so `cd` persists across the session
   * (cleared only on a full page refresh, which remounts this component).
   * null/undefined when the runner couldn't report it — the prior cwd is kept.
   */
  cwd?: string | null;
}

/**
 * Injected runner — the page binds this to a `run_sandbox_command` action.
 * `opts.cwd` carries the prior working directory so the stateless per-command
 * shell resumes where the last one left off.
 */
export type RunCommandFn = (
  command: string,
  opts?: { cwd?: string },
) => Promise<SandboxExecResult>;

/** A completed (or in-flight / queued) scrollback entry. */
export interface TerminalEntry extends Partial<SandboxExecResult> {
  command: string;
  status: "queued" | "running" | "done" | "error";
}

/** Internal entry — a stable key so async result updates target the right row. */
interface InternalEntry extends TerminalEntry {
  key: number;
}

export interface SandboxTerminalProps {
  /** Durable-session id (sbx_…) — shown in the prompt, not otherwise used here. */
  sessionId: string;
  runCommand: RunCommandFn;
  /**
   * Working directory the session starts in — shown in the prompt and threaded
   * into the first command so a `cd`-less `ls` lands where the files actually
   * live (the workspace root, `/work`). Falls back to the last history row's
   * cwd, then to the image default. A later command's reported cwd overrides it.
   */
  initialCwd?: string;
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
  if (entry.status === "queued") {
    return <span className="term-fg-faint">queued…</span>;
  }
  if (entry.status === "running") {
    return <span className="term-fg-muted">running…</span>;
  }
  if (entry.status === "error") {
    return <span className="term-exit-bad">✗ error</span>;
  }
  const code = entry.exitCode ?? 0;
  const ok = code === 0;
  return (
    <span className={ok ? "term-exit-ok" : "term-exit-bad"}>
      {ok ? "▲" : "✗"} exit {code}
      <span className="term-fg-faint">
        {entry.timedOut ? " · timed out" : ""}
        {entry.restored ? " · restored" : ""}
        {typeof entry.executionMs === "number"
          ? ` · ${entry.executionMs}ms`
          : ""}
      </span>
    </span>
  );
}

/**
 * The ❯ prompt glyph + optional cwd, shared by scrollback rows and the live
 * input. `testId` is set only on the live input prompt so the id stays unique.
 */
function PromptGlyph({
  cwd,
  testId,
}: {
  cwd?: string | null;
  testId?: string;
}) {
  return (
    <>
      {cwd ? (
        <span
          className="term-path shrink-0 whitespace-pre"
          title={cwd}
          data-testid={testId}
        >
          {cwd}
        </span>
      ) : null}
      <span className="term-glyph shrink-0 font-semibold" aria-hidden>
        ❯
      </span>
    </>
  );
}

export function SandboxTerminal({
  sessionId,
  runCommand,
  initialCwd,
  initialHistory = [],
  disabled = false,
  welcome,
  className,
}: SandboxTerminalProps) {
  // Monotonic key generator; seeded past the pre-loaded history rows (which
  // take indexes 0..n-1) so refs are never read during render.
  const keyRef = useRef(initialHistory.length);
  const [entries, setEntries] = useState<InternalEntry[]>(() =>
    initialHistory.map((e, i) => ({ ...e, key: i })),
  );
  const [input, setInput] = useState("");

  // Current working directory, reconstructed from each command's result. Held
  // in a ref (read synchronously inside the async queue drainer) AND mirrored to
  // state (for the live prompt). Survives command→command but resets on a full
  // page refresh, which remounts this component — exactly the requested
  // lifetime. Seeded from the last history row that carried a cwd.
  const seededCwd = useMemo(() => {
    // An explicit initialCwd (the workspace root) wins; otherwise fall back to
    // the last history row that carried a cwd, then the image default.
    if (initialCwd) return initialCwd;
    for (let i = initialHistory.length - 1; i >= 0; i--) {
      const c = initialHistory[i]?.cwd;
      if (c) return c;
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seed once from the initial props
  }, []);
  const cwdRef = useRef<string | undefined>(seededCwd);
  const [cwd, setCwd] = useState<string | undefined>(seededCwd);

  // FIFO queue of not-yet-started commands and a single-flight drain guard.
  const queueRef = useRef<Array<{ key: number; command: string }>>([]);
  const drainingRef = useRef(false);

  // Command history navigation (↑/↓), most-recent last.
  const [historyIdx, setHistoryIdx] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const commandHistory = useMemo(
    () => entries.map((e) => e.command).filter((c) => c.length > 0),
    [entries],
  );

  // Anything still queued or running keeps the "working…" indicator lit.
  const working = useMemo(
    () => entries.some((e) => e.status === "queued" || e.status === "running"),
    [entries],
  );

  // Keep the newest output in view.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries]);

  /**
   * Focus the command input, but never fight the user: skip when a text
   * selection is active (they're copying output) and skip when focus has moved
   * to a control OUTSIDE the terminal (e.g. the files drawer).
   */
  const focusInput = useCallback(() => {
    const el = inputRef.current;
    if (!el || disabled) return;
    const sel = typeof window !== "undefined" ? window.getSelection?.() : null;
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed) return;
    const active = document.activeElement;
    const root = rootRef.current;
    if (active && active !== document.body && root && !root.contains(active)) {
      return;
    }
    el.focus();
  }, [disabled]);

  /**
   * Drain the queue FIFO. Single-flight: only one drainer runs at a time, so
   * commands execute strictly in order even if several are enqueued at once.
   */
  const drain = useCallback(async () => {
    if (drainingRef.current) return;
    drainingRef.current = true;
    try {
      while (queueRef.current.length > 0) {
        const item = queueRef.current.shift();
        if (!item) break;
        const runCwd = cwdRef.current;
        // Promote the queued row to running, recording the cwd it runs in.
        setEntries((prev) =>
          prev.map((e) =>
            e.key === item.key ? { ...e, status: "running", cwd: runCwd } : e,
          ),
        );
        try {
          const result = await runCommand(item.command, { cwd: runCwd });
          // Advance the working directory for the next command; ignore a
          // null/undefined cwd (pre-cwd runner) so the prior one is kept.
          if (result.cwd) {
            cwdRef.current = result.cwd;
            setCwd(result.cwd);
          }
          setEntries((prev) =>
            prev.map((e) =>
              e.key === item.key
                ? { ...e, status: "done", ...result, cwd: runCwd }
                : e,
            ),
          );
        } catch (err) {
          const message =
            err instanceof Error ? err.message : "Command failed to run.";
          setEntries((prev) =>
            prev.map((e) =>
              e.key === item.key
                ? {
                    key: e.key,
                    command: item.command,
                    status: "error",
                    stdout: "",
                    stderr: message,
                    exitCode: -1,
                    executionMs: 0,
                    timedOut: false,
                    cwd: runCwd,
                  }
                : e,
            ),
          );
        } finally {
          // Refocus after each command so type-ahead continues uninterrupted.
          focusInput();
        }
      }
    } finally {
      drainingRef.current = false;
    }
  }, [runCommand, focusInput]);

  const submit = useCallback(() => {
    const command = input.trim();
    // `disabled` (session unrunnable) blocks submission; a running command does
    // NOT — Enter-while-busy enqueues instead, so the cursor is never lost.
    if (command.length === 0 || disabled) return;
    const key = keyRef.current++;
    queueRef.current.push({ key, command });
    setEntries((prev) => [...prev, { key, command, status: "queued" }]);
    setInput("");
    setHistoryIdx(null);
    void drain();
  }, [input, disabled, drain]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
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

  // Clicking the console focuses the input — but not when the user is selecting
  // text (a drag-select leaves a non-collapsed selection at click time).
  const onSurfaceClick = useCallback(() => {
    const sel = typeof window !== "undefined" ? window.getSelection?.() : null;
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed) return;
    inputRef.current?.focus();
  }, []);

  const shortId =
    sessionId.length > 14 ? `${sessionId.slice(0, 12)}…` : sessionId;

  return (
    <div
      ref={rootRef}
      onClick={onSurfaceClick}
      className={cn(
        "sandbox-term flex w-full flex-col overflow-hidden rounded-xl border shadow-sm",
        className,
      )}
    >
      <div className="term-border flex items-center justify-between border-b px-3.5 py-2">
        <span className="term-fg-muted font-mono text-xs">
          terminal · {shortId}
        </span>
        {working ? (
          <span className="term-glyph flex items-center gap-1.5 font-mono text-xs">
            <span className="inline-block size-1.5 animate-pulse rounded-full bg-current" />
            working…
          </span>
        ) : null}
      </div>

      <div
        ref={scrollRef}
        role="log"
        aria-label="Sandbox terminal output"
        aria-live="polite"
        data-testid="sandbox-terminal-scrollback"
        className="term-fg h-[60vh] max-h-[46rem] min-h-[24rem] flex-1 overflow-y-auto overflow-x-auto p-4 font-mono text-sm leading-relaxed"
      >
        {welcome ? (
          <div className="term-fg-muted mb-3 whitespace-pre-wrap">
            {welcome}
          </div>
        ) : null}

        {entries.length === 0 && !welcome ? (
          <div className="term-fg-faint">
            Type a command and press Enter to run it in this sandbox.
          </div>
        ) : null}

        {entries.map((entry) => (
          <div key={entry.key} className="mb-2.5">
            <div className="flex items-baseline gap-2">
              <PromptGlyph cwd={entry.cwd} />
              <span className="term-fg whitespace-pre-wrap break-words">
                {entry.command}
              </span>
            </div>
            {entry.stdout ? <AnsiLines text={entry.stdout} /> : null}
            {entry.stderr ? (
              <div className="text-error">
                <AnsiLines text={entry.stderr} />
              </div>
            ) : null}
            <div className="mt-0.5 text-[11px] uppercase tracking-wide">
              <ExitTag entry={entry} />
            </div>
          </div>
        ))}
      </div>

      <div className="term-border flex items-center gap-2 border-t px-3.5 py-2.5">
        <PromptGlyph cwd={cwd} testId="sandbox-terminal-cwd" />
        <input
          ref={inputRef}
          type="text"
          value={input}
          disabled={disabled}
          autoFocus={!disabled}
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
            "term-fg flex-1 bg-transparent font-mono text-sm placeholder:text-[color:var(--term-fg-faint)]",
            "focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60",
          )}
        />
      </div>
    </div>
  );
}

export default SandboxTerminal;
