/**
 * Interactive REPL — the default `oxagen` experience.
 *
 * Full-screen Ink TUI with:
 *   - Scrollable conversation history (user prompts + assistant responses)
 *   - A thinking indicator (spinner + elapsed time + live token estimate) and a
 *     session token counter in the status bar
 *   - Multi-turn history, project rules, and Oxagen context-engine memory
 *   - Slash commands (/help, /model, /clear, /exit), prompt queue, Esc/Ctrl-C cancel
 *
 * Presentational pieces live in ./components; this file is the container.
 */
import { Box, Text, useApp, useInput, useStdout } from "ink";
import React, { useState, useCallback, useRef, useEffect } from "react";
import type { ModelMessage } from "ai";
import { theme } from "../tui/theme.js";
import { runTurn } from "@oxagen/agent-engine";
import {
  createCwdWorkspace,
  createGatedWorkspace,
  createCombinedMemory,
  createCodeGraphProvider,
  createGraphSyncProvider,
  createPlatformAgentAi,
} from "../agent/adapters/index.js";
import { queryCodeGraph } from "../agent/code-graph.js";
import type { Session } from "../lib/session.js";
import {
  resolveModelId,
  resolveEffort,
  isReasoningEffort,
  EFFORT_LEVELS,
  type ReasoningEffort,
} from "../agent/model.js";
import { loadProjectContext } from "../agent/project-context.js";
import { loadAndExpand, parseInvocation } from "../slash/expand.js";
import { buildSlashCatalog, type SlashCatalogEntry } from "../slash/catalog.js";
import { buildProgram, describeCliCommands } from "../program.js";
import { isProjectInitialized, initializeProject } from "../project/init.js";
import { openSessionMemory, type SessionMemory } from "../agent/memory.js";
import { openFleetMemory } from "../agent/fleet/memory.js";
import { openTraceStore } from "../agent/trace-store.js";
import { appendVerboseLog } from "../agent/verbose-log.js";
import { formatVerboseSection } from "../agent/trace-format.js";
import { readConfig, writeConfig } from "../lib/config.js";
import { debugLog } from "../lib/debug-log.js";
import { formatToolArgs } from "../agent/tool-formatter.js";
import {
  ApprovalPrompt,
  HELP,
  MessageView,
  PromptInput,
  StatusLine,
  ThinkingIndicator,
  summarizeTrace,
  type Message,
  type TuiMode,
} from "./components.js";
import { resolveEscapeAction } from "./escape-action.js";
import { isDebugEnabled } from "../lib/debug-log.js";
import { Banner } from "../tui/banner.js";
import {
  makeTurnController,
  makeStallDetector,
  AgentTimeoutError,
  TIMEOUTS,
} from "../agent/timeouts.js";
import {
  makeTurnController,
  makeStallDetector,
  AgentTimeoutError,
  TIMEOUTS,
} from "../agent/timeouts.js";
import {
  PermissionBroker,
  parseModeArg,
  resolveMode,
  persistedRuleString,
  type ApprovalRequest,
  type ApprovalResponse,
  type PermissionMode,
} from "../agent/permissions.js";
import pkg from "../../package.json" with { type: "json" };

export interface ReplOptions {
  /** Authenticated platform session (token, org, workspace). */
  session: Session;
  model?: string;
  /** Initial reasoning effort for models that support it (low|medium|high). */
  effort?: string;
  readOnly?: boolean;
  /** Initial permission posture; defaults to `ask` (or `readonly` when readOnly). */
  mode?: PermissionMode;
  /** Start with the eval→enhance→judge pipeline disabled (bare agent). */
  bare?: boolean;
  /** Start in verbose mode: capture + emit full per-turn telemetry. */
  verbose?: boolean;
}

// ── Main App ──────────────────────────────────────────────────────────────────

/**
 * Human-readable summary of a tool call's input for the tool chip — the pretty
 * `edit(a.ts)` / `bash(git push)` form, never the raw JSON argument object.
 */
function summarizeInput(toolName: string, input: unknown): string {
  return formatToolArgs(toolName, input);
}

// Alternate-screen control sequences: 1049h swaps to the alt buffer (and 1049l
// restores the user's scrollback on exit); [H homes the cursor so the first
// frame draws from the top of the screen rather than wherever the prompt was.
const ALT_SCREEN_ENTER = "\x1b[?1049h\x1b[H";
const ALT_SCREEN_LEAVE = "\x1b[?1049l";

/**
 * Drive fullscreen (alternate-screen) layout for the REPL.
 *
 * When `active`, the app swaps to the terminal's alternate screen buffer and
 * reports its current row count so the root Box can be pinned to the full
 * terminal height (header at top, input pinned at the bottom). When inactive —
 * or on unmount/exit — the alt buffer is left so the user's shell scrollback is
 * restored untouched. Toggling at runtime re-runs the effect, so `/tui` flips
 * cleanly between compact and fullscreen.
 */
function useFullscreen(active: boolean): number {
  const { stdout } = useStdout();
  const [rows, setRows] = useState<number>(stdout?.rows ?? 24);

  useEffect(() => {
    if (!active || !stdout) return;
    stdout.write(ALT_SCREEN_ENTER);
    const sync = (): void => setRows(stdout.rows ?? 24);
    sync();
    stdout.on("resize", sync);
    return () => {
      stdout.off("resize", sync);
      stdout.write(ALT_SCREEN_LEAVE);
    };
  }, [active, stdout]);

  return rows;
}

export function ReplApp({
  options,
}: {
  options: ReplOptions;
}): React.ReactElement {
  const { exit } = useApp();
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [model, setModel] = useState<string>(resolveModelId(options.model));
  // Reasoning effort for models that support a thinking mode (undefined = let
  // the model/server default decide). Driven by /effort; forwarded per turn.
  const [effort, setEffort] = useState<ReasoningEffort | undefined>(
    resolveEffort(options.effort),
  );
  const [turns, setTurns] = useState(0);
  // Cumulative session token usage (exact, from the model's reported usage).
  const [usage, setUsage] = useState<{ input: number; output: number }>({
    input: 0,
    output: 0,
  });
  // When the active turn began (drives the thinking indicator); null when idle.
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);
  // Output chars streamed this turn, for the live token estimate in the indicator.
  const streamCharsRef = useRef(0);
  // Prompts submitted while a turn is in flight wait here and run FIFO when the
  // current turn finishes (Claude Code-style prompt queue). `queued` drives the
  // visible list; `queueRef` is the synchronous source of truth the pump reads.
  const [queued, setQueued] = useState<string[]>([]);
  const queueRef = useRef<string[]>([]);
  const pumpingRef = useRef(false);

  // Whether the eval→enhance→judge pipeline is active (vs. the bare agent).
  const [pipelineOn, setPipelineOn] = useState(!options.bare);
  const bareRef = useRef(options.bare ?? false);

  // Verbose telemetry: capture per-phase timing/model/cost + tool results, write
  // the JSONL stream, and show the breakdown inline. Defaults from config.
  const initialVerbose = options.verbose ?? readConfig().verbose ?? false;
  const [verboseOn, setVerboseOn] = useState(initialVerbose);
  const verboseRef = useRef(initialVerbose);
  // Layout mode: "compact" (inline scrollback) vs. "fullscreen" (alternate
  // screen, pinned to the terminal height). Defaults from config; toggled by
  // /tui. useFullscreen swaps the alt buffer + reports the live row count.
  const [tuiMode, setTuiMode] = useState<TuiMode>(
    // Fullscreen is the default REPL experience; opt out with `/tui compact`
    // or a persisted `tui: "compact"` in config.
    readConfig().tui === "compact" ? "compact" : "fullscreen",
  );
  const fullscreen = tuiMode === "fullscreen";
  const rows = useFullscreen(fullscreen);
  // Permission posture (drives the broker + status chip) and the in-flight
  // approval request (drives the inline ApprovalPrompt; null when none).
  const [mode, setMode] = useState<PermissionMode>(
    options.mode ?? resolveMode({ readOnly: options.readOnly }),
  );
  const [approval, setApproval] = useState<{
    req: ApprovalRequest;
    resolve: (r: ApprovalResponse) => void;
  } | null>(null);

  const cwd = process.cwd();
  // Engine ports — created once for the session. The workspace stays bare here;
  // it's wrapped with the permission broker (createGatedWorkspace) at call time
  // so /mode changes take effect without re-creating the workspace.
  const workspaceRef = useRef(createCwdWorkspace(cwd));
  const aiRef = useRef(
    createPlatformAgentAi({
      apiUrl: options.session.apiUrl,
      token: options.session.token,
      orgSlug: options.session.orgSlug,
      workspaceSlug: options.session.workspaceSlug,
    }),
  );
  const codeGraphRef = useRef(
    createCodeGraphProvider((op, q, l) => queryCodeGraph(cwd, op, q, l)),
  );
  const graphSyncRef = useRef(createGraphSyncProvider({ ...options.session, cwd }));
  // Project rules (CLAUDE.md/AGENTS.md) loaded once for the session.
  const projectContextRef = useRef(loadProjectContext(cwd));
  // Unified slash-command catalog — built-in REPL commands + every `oxagen --help`
  // command + custom .md commands — built once. Powers the typeahead menu and the
  // CLI-command hints in handleSubmit. buildProgram() is pure introspection: no
  // parse, no I/O, no side effects.
  const catalogRef = useRef<SlashCatalogEntry[] | null>(null);
  if (!catalogRef.current) {
    catalogRef.current = buildSlashCatalog({
      cwd,
      cliCommands: describeCliCommands(buildProgram()),
    });
  }
  // Oxagen context-engine memory, opened asynchronously on mount.
  const memoryRef = useRef<SessionMemory | null>(null);
  // Fleet memory (weighted lessons) and the per-turn trace store, both synchronous.
  const fleetMemoryRef = useRef(openFleetMemory(cwd));
  const traceStoreRef = useRef(openTraceStore(cwd));
  // Source-of-truth message list (the state mirror), so streaming updates can be
  // computed synchronously without racing React's batched setState.
  const allRef = useRef<Message[]>([]);
  // Multi-turn conversation history fed back to the model each turn.
  const historyRef = useRef<ModelMessage[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const streamingRef = useRef(false);
  const modelRef = useRef(model);
  modelRef.current = model;
  const effortRef = useRef(effort);
  effortRef.current = effort;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const tuiModeRef = useRef(tuiMode);
  tuiModeRef.current = tuiMode;
  const approvalRef = useRef(approval);
  approvalRef.current = approval;

  // Whether we are showing the "reset conversation?" confirmation prompt.
  // The ref is the synchronous source of truth; the state drives the render.
  const [resetPending, setResetPending] = useState(false);
  const resetPendingRef = useRef(false);
  // Timestamp of the most-recent Escape press (for the double-Esc detection
  // window). Null means no previous Esc has been recorded (or the window was
  // explicitly cleared after a 'prompt-reset' fires).
  const lastEscapeRef = useRef<number | null>(null);

  // The permission broker, created once. Its approver surfaces an inline prompt
  // and resolves when the user answers (see ApprovalPrompt / resolveApproval).
  const brokerRef = useRef<PermissionBroker | null>(null);
  if (!brokerRef.current) {
    brokerRef.current = new PermissionBroker({
      mode: modeRef.current,
      cwd,
      approver: (req) =>
        new Promise<ApprovalResponse>((resolve) => setApproval({ req, resolve })),
    });
  }

  useEffect(() => {
    let mem: SessionMemory | null = null;
    // Guards the async-open race: if the component unmounts before
    // `openSessionMemory` resolves, the cleanup below runs while `mem` is still
    // null and cannot close the handle. Without this flag the resolved
    // SessionMemory (and its DuckDB connection) would leak for the life of the
    // process. When the open lands after unmount we close it immediately.
    let cancelled = false;
    void openSessionMemory(cwd, `repl-${Date.now()}`)
      .then((m) => {
        if (cancelled) {
          void m?.close();
          return;
        }
        mem = m;
        memoryRef.current = m;
      })
      .catch(() => {
        // openSessionMemory is best-effort and already fails closed (returns
        // null) internally; swallow any unexpected rejection so it can never
        // surface as an unhandled rejection from this effect.
      });
    return () => {
      cancelled = true;
      void mem?.close();
    };
  }, [cwd]);

  const commit = useCallback((next: Message[]) => {
    allRef.current = next;
    setMessages(next);
  }, []);

  const pushAssistant = useCallback(
    (content: string) => {
      commit([
        ...allRef.current,
        { role: "assistant", content, timestamp: Date.now() },
      ]);
    },
    [commit],
  );

  const cancelTurn = useCallback(() => {
    // Cancel the in-flight turn and drop anything queued behind it.
    queueRef.current = [];
    setQueued([]);
    // Release any pending permission prompt as a denial so the tool unblocks.
    approvalRef.current?.resolve({ decision: "deny" });
    setApproval(null);
    // Abort the turn signal. The engine now throws on an aborted signal the
    // moment the current stream ends (no extra judge/summarize call), and the
    // stream callbacks below no-op once aborted, so no late text renders.
    abortRef.current?.abort();
    // Return the UI to idle IMMEDIATELY so Esc feels instant even if the
    // underlying HTTP stream takes a moment to unwind. The turn's own finally
    // block also clears this state when the aborted promise finally settles.
    streamingRef.current = false;
    setIsStreaming(false);
    setTurnStartedAt(null);
  }, []);

  /**
   * Shared conversation reset — used by both the /clear slash command and the
   * Esc-twice flow. Wipes all in-memory conversation and history state.
   */
  const resetConversation = useCallback(() => {
    allRef.current = [];
    historyRef.current = [];
    setMessages([]);
  }, []);

  // Resolve the in-flight approval prompt with the user's answer, clear it, and
  // echo a confirmation so the user always sees the outcome of their decision.
  // On "allow + remember" we also name the exact rule the broker persists to
  // .oxagen/settings.json, so the workspace file update is never silent.
  const resolveApproval = useCallback(
    (response: ApprovalResponse) => {
      const cur = approvalRef.current;
      cur?.resolve(response);
      setApproval(null);
      if (!cur) return;
      const { req } = cur;
      if (response.decision === "allow") {
        let msg = `✓ Allowed · ${req.summary}`;
        if (response.remember) {
          const rule = persistedRuleString(req, "allow", cwd);
          msg +=
            `\n  ↳ saved allow-rule ${rule} to .oxagen/settings.json — ` +
            `matching calls now run without asking.`;
        }
        pushAssistant(msg);
      } else {
        pushAssistant(`✗ Denied · ${req.summary}`);
      }
    },
    [cwd, pushAssistant],
  );

  useInput((input, key) => {
    // Ctrl-C is handled first so it works even while a permission prompt is up
    // (cancelTurn releases the prompt as a denial before aborting).
    if (key.ctrl && input === "c") {
      if (streamingRef.current && abortRef.current) {
        cancelTurn();
      } else {
        void memoryRef.current?.close();
        exit();
      }
      return;
    }
    // While a permission prompt is up, ApprovalPrompt owns Esc and the answer keys.
    if (approvalRef.current) return;

    if (key.escape) {
      // If the reset-confirmation prompt is already visible, Esc cancels it
      // immediately (without going through the submit path).
      if (resetPendingRef.current) {
        resetPendingRef.current = false;
        setResetPending(false);
        pushAssistant("Reset cancelled.");
        // Clear the window so this cancellation Esc doesn't seed a new pair.
        lastEscapeRef.current = null;
        return;
      }

      const now = Date.now();
      const action = resolveEscapeAction(
        {
          isStreaming: streamingRef.current,
          resetPending: false, // handled above
          lastEscapeMs: lastEscapeRef.current,
        },
        now,
      );
      // Always record this Esc's timestamp so the next press can measure
      // the gap, UNLESS we are about to open the confirm prompt (in which
      // case we clear it so a third Esc after cancel starts a fresh pair).
      if (action === "prompt-reset") {
        lastEscapeRef.current = null;
      } else {
        lastEscapeRef.current = now;
      }

      if (action === "stop") {
        pushAssistant("⏹ Agent interrupted (Esc)");
        cancelTurn();
      } else if (action === "prompt-reset") {
        resetPendingRef.current = true;
        setResetPending(true);
      }
      // 'none' → no-op; timestamp already recorded above.
    }
  });

  const handleSubmit = useCallback(
    async (text: string) => {
      // ── Reset-confirmation gate ───────────────────────────────────────────
      // When the Esc-twice prompt is visible, the next submission is treated
      // as the user's confirmation answer, NOT as a slash command or prompt.
      if (resetPendingRef.current) {
        resetPendingRef.current = false;
        setResetPending(false);
        const answer = text.trim().toLowerCase();
        if (answer === "y" || answer === "yes") {
          resetConversation();
          pushAssistant("🗑 Conversation reset.");
        } else {
          pushAssistant("Reset cancelled.");
        }
        return;
      }

      // ── Shell escape (`!cmd`) ──
      // A prompt beginning with "!" runs the rest as a shell command in the
      // workspace, like Claude Code. The user typed it explicitly, so it runs
      // directly (not through the agent's permission broker). Output is shown in
      // the conversation AND fed into history so the model sees it next turn.
      if (text.startsWith("!")) {
        const command = text.slice(1).trim();
        if (!command) {
          pushAssistant("Usage: !<shell command> — runs it in the workspace and shows the output.");
          return;
        }
        commit([...allRef.current, { role: "user", content: text, timestamp: Date.now() }]);
        try {
          const res = await workspaceRef.current.exec(command, {
            timeoutMs: TIMEOUTS.toolLongMs,
          });
          const merged = [res.stdout, res.stderr].filter(Boolean).join("\n").trimEnd();
          const body = merged || "(no output)";
          const tail = res.timedOut
            ? "\n(timed out)"
            : res.exitCode !== 0
              ? `\n(exit ${res.exitCode})`
              : "";
          pushAssistant("```\n$ " + command + "\n" + body + "\n```" + tail);
          // Make the model aware of what the user ran and what it produced.
          historyRef.current = [
            ...historyRef.current,
            {
              role: "user",
              content:
                `I ran \`${command}\` in the shell (exit ${res.exitCode}). Output:\n` +
                body.slice(0, 4000),
            },
          ];
        } catch (err) {
          pushAssistant(
            `Command failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        return;
      }

      // ── Slash commands ──
      if (text === "/help") {
        pushAssistant(HELP);
        return;
      }
      if (text === "/tui" || text.startsWith("/tui ")) {
        const arg = text.slice("/tui".length).trim().toLowerCase();
        let next: TuiMode;
        if (arg === "") {
          // No argument toggles between the two layouts.
          next = tuiModeRef.current === "fullscreen" ? "compact" : "fullscreen";
        } else if (arg === "compact" || arg === "fullscreen") {
          next = arg;
        } else {
          pushAssistant(
            `Unknown layout "${arg}". Use /tui compact|fullscreen (or /tui alone to toggle).`,
          );
          return;
        }
        setTuiMode(next);
        // Remember the choice so the next session starts in the same layout.
        writeConfig({ tui: next });
        pushAssistant(
          next === "fullscreen"
            ? "Layout: fullscreen — the REPL fills the alternate screen. /tui compact returns to inline scrollback."
            : "Layout: compact — the REPL renders inline in your scrollback. /tui fullscreen uses the alternate screen.",
        );
        return;
      }
      if (text === "/init") {
        pushAssistant("Initializing…");
        try {
          const { runInit, formatInitSummary } = await import("../commands/init.js");
          const result = await runInit({ cwd });
          pushAssistant(formatInitSummary(result));
        } catch (err) {
          pushAssistant(
            `Init failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        return;
      }
      if (text === "/clear") {
        resetConversation();
        return;
      }
      if (text.startsWith("/model")) {
        const slug = text.slice("/model".length).trim();
        if (slug) {
          // Any gateway/Vercel-SDK model slug that supports text I/O is accepted
          // — there is no allowlist. If the gateway rejects the slug the next
          // turn surfaces a clear 4xx; switch with /model <vendor/model>.
          setModel(slug);
          pushAssistant(
            `Model set to ${slug}. (Any valid text model slug is accepted; ` +
              `the gateway resolves it at request time.)`,
          );
        } else {
          pushAssistant(`Current model: ${modelRef.current}`);
        }
        return;
      }
      if (text.startsWith("/effort")) {
        const arg = text.slice("/effort".length).trim().toLowerCase();
        if (!arg) {
          pushAssistant(
            `Reasoning effort: ${effortRef.current ?? "model default"}. ` +
              `Use /effort ${EFFORT_LEVELS.join("|")}|default (applies to models with a thinking mode).`,
          );
        } else if (arg === "default" || arg === "off" || arg === "none") {
          setEffort(undefined);
          pushAssistant(
            "Reasoning effort cleared — the model/server default now governs.",
          );
        } else if (isReasoningEffort(arg)) {
          setEffort(arg);
          pushAssistant(
            `Reasoning effort set to ${arg}. Models with a thinking mode will ` +
              `think ${arg === "high" ? "harder (more tokens, higher cost)" : arg}; ` +
              `models without one ignore it.`,
          );
        } else {
          pushAssistant(
            `Unknown effort "${arg}". Use ${EFFORT_LEVELS.join(", ")}, or default.`,
          );
        }
        return;
      }
      if (text.startsWith("/mode")) {
        const arg = text.slice("/mode".length).trim();
        const next = arg ? parseModeArg(arg) : undefined;
        if (!arg) {
          pushAssistant(
            `Permission mode: ${modeRef.current}. Use /mode ask|auto-edit|bypass|readonly.`,
          );
        } else if (next) {
          setMode(next);
          brokerRef.current?.setMode(next);
          pushAssistant(
            `Permission mode set to ${next}.` +
              (next === "bypass"
                ? " ⚠ tool calls now run without confirmation."
                : next === "readonly"
                  ? " File edits and commands are disabled."
                  : ""),
          );
        } else {
          pushAssistant(`Unknown mode "${arg}". Use ask, auto-edit, bypass, or readonly.`);
        }
        return;
      }
      if (text.startsWith("/replay")) {
        const arg = text.slice("/replay".length).trim();
        const trace = traceStoreRef.current.resolve(arg);
        if (!trace) {
          pushAssistant(
            arg
              ? `No turn matches "${arg}". Try /traces to list recent turns.`
              : "No turns recorded yet. Run a prompt first.",
          );
        } else {
          commit([
            ...allRef.current,
            { role: "assistant", content: "", trace, timestamp: Date.now() },
          ]);
        }
        return;
      }
      if (text === "/traces") {
        const traces = traceStoreRef.current.list();
        pushAssistant(
          traces.length === 0
            ? "No turns recorded yet."
            : "Recent turns (use /replay <n>):\n" +
                traces.slice(0, 10).map((t, i) => summarizeTrace(t, i)).join("\n"),
        );
        return;
      }
      if (text.startsWith("/pipeline")) {
        const arg = text.slice("/pipeline".length).trim().toLowerCase();
        if (arg === "off") {
          bareRef.current = true;
          setPipelineOn(false);
          pushAssistant("Pipeline OFF — running the bare agent (no eval/enhance/judge).");
        } else if (arg === "on") {
          bareRef.current = false;
          setPipelineOn(true);
          pushAssistant("Pipeline ON — prompts are evaluated, enhanced, and judged for completeness.");
        } else {
          pushAssistant(`Pipeline is ${bareRef.current ? "OFF" : "ON"}. Use /pipeline on|off.`);
        }
        return;
      }
      if (text.startsWith("/verbose")) {
        const arg = text.slice("/verbose".length).trim().toLowerCase();
        if (arg === "off") {
          verboseRef.current = false;
          setVerboseOn(false);
          pushAssistant("Verbose OFF.");
        } else if (arg === "on" || arg === "") {
          verboseRef.current = true;
          setVerboseOn(true);
          pushAssistant(
            "Verbose ON — each turn now reports per-phase timing, the model + tokens + " +
              "cost for enhance / work / review, tool calls + results, and the injected " +
              "context. Structured records also stream to the verbose JSONL log.",
          );
        } else {
          pushAssistant(`Verbose is ${verboseRef.current ? "ON" : "OFF"}. Use /verbose on|off.`);
        }
        return;
      }
      if (text === "/login" || text.startsWith("/login ")) {
        // The interactive picker needs readline which Ink owns — so we can't
        // run the full flow from inside the REPL. Show the current session
        // when already logged in; otherwise instruct the user to use the shell.
        try {
          const { getToken, readConfig } = await import("../lib/config.js");
          const token = getToken();
          const config = readConfig();
          if (token && config.orgSlug && config.workspaceSlug) {
            const masked = token.length <= 8 ? "****" : token.slice(0, 4) + "…" + token.slice(-4);
            pushAssistant(
              `Logged in to Oxagen:\n` +
                `  token:     ${masked}\n` +
                `  org:       ${config.orgSlug}\n` +
                `  workspace: ${config.workspaceSlug}\n` +
                `\nRun \`oxagen logout\` in your shell to clear the session.`,
            );
          } else {
            pushAssistant(
              `Not logged in. The interactive login picker requires a shell TTY.\n` +
                `Run \`oxagen login\` in your terminal to authenticate.`,
            );
          }
        } catch (err) {
          pushAssistant(err instanceof Error ? err.message : String(err));
        }
        return;
      }
      if (text === "/logout") {
        try {
          const { clearConfig, readConfig } = await import("../lib/config.js");
          const config = readConfig();
          if (!config.token && !config.orgSlug && !config.workspaceSlug) {
            pushAssistant("Not logged in.");
          } else {
            clearConfig();
            pushAssistant(
              "Logged out. Session cleared from ~/.config/oxagen/config.json.\n" +
                "Note: per-project links (.oxagen/workspace.json) are left intact.",
            );
          }
        } catch (err) {
          pushAssistant(err instanceof Error ? err.message : String(err));
        }
        return;
      }
      if (text === "/remember" || text.startsWith("/remember ")) {
        const body = text.slice("/remember".length).trim();
        if (!body) {
          pushAssistant(
            "Usage: /remember <text> — captures a memory (infers its kind + weight) and saves it to the workspace graph.",
          );
          return;
        }
        pushAssistant("Remembering…");
        try {
          const { rememberMemory, formatRememberResult } = await import(
            "../lib/memory-client.js"
          );
          pushAssistant(formatRememberResult(await rememberMemory({ text: body })));
        } catch (err) {
          pushAssistant(err instanceof Error ? err.message : String(err));
        }
        return;
      }
      if (text === "/memories" || text.startsWith("/memories ")) {
        const arg = text.slice("/memories".length).trim();
        try {
          const { listMemories, formatMemoryLines, MEMORY_KINDS } = await import(
            "../lib/memory-client.js"
          );
          let kind: (typeof MEMORY_KINDS)[number] | undefined;
          if (arg) {
            if (!MEMORY_KINDS.includes(arg as (typeof MEMORY_KINDS)[number])) {
              pushAssistant(`Unknown kind "${arg}". Use one of: ${MEMORY_KINDS.join(", ")}.`);
              return;
            }
            kind = arg as (typeof MEMORY_KINDS)[number];
          }
          pushAssistant(formatMemoryLines(await listMemories({ kind, limit: 30 })));
        } catch (err) {
          pushAssistant(err instanceof Error ? err.message : String(err));
        }
        return;
      }
      if (text === "/forget" || text.startsWith("/forget ")) {
        const id = text.slice("/forget".length).trim();
        if (!id) {
          pushAssistant("Usage: /forget <id> — permanently deletes a memory by id (see /memories).");
          return;
        }
        try {
          const { deleteMemory } = await import("../lib/memory-client.js");
          const { deleted } = await deleteMemory(id);
          pushAssistant(
            deleted ? `✓ Forgot memory ${id}.` : `No memory ${id} found in this workspace.`,
          );
        } catch (err) {
          pushAssistant(err instanceof Error ? err.message : String(err));
        }
        return;
      }
      if (text === "/exit" || text === "/quit") {
        void memoryRef.current?.close();
        exit();
        return;
      }

      // User-defined slash commands (.oxagen/commands/*.md): a `/name args` that
      // isn't a built-in expands into the prompt below.
      let submission = text;
      if (text.startsWith("/")) {
        const expanded = loadAndExpand(text, { cwd });
        if (expanded && "error" in expanded) {
          pushAssistant(expanded.error);
          return;
        }
        if (expanded) {
          submission = expanded.prompt;
        } else {
          // Not a built-in and not a custom .md command. If it's one of the
          // productized `oxagen --help` commands surfaced in the menu, point the
          // user at the shell rather than failing — those run outside the REPL.
          const name = parseInvocation(text)?.name ?? text.split(/\s+/)[0]!.slice(1);
          const entry = catalogRef.current?.find((c) => c.name === name);
          if (entry && entry.source === "cli") {
            const hint = entry.argumentHint ? ` ${entry.argumentHint}` : "";
            pushAssistant(
              `📦 oxagen ${entry.name}${hint} — ${entry.description}\n` +
                `This is an oxagen CLI command — run it from your shell: oxagen ${entry.name}`,
            );
          } else {
            pushAssistant(
              `Unknown command: /${name}. Type /help for built-ins, or / to browse the menu.`,
            );
          }
          return;
        }
      }

      const userMsg: Message = {
        role: "user",
        content: submission,
        timestamp: Date.now(),
      };
      const base = [...allRef.current, userMsg];
      commit(base);
      setIsStreaming(true);
      streamingRef.current = true;
      setTurnStartedAt(Date.now());
      streamCharsRef.current = 0;
      const controller = new AbortController();
      abortRef.current = controller;

      // Bound the whole turn: makeTurnController fires when EITHER the user hits
      // Esc/Ctrl-C (controller) OR the per-turn deadline (TIMEOUTS.turnMs) elapses.
      // A stall detector layered on top aborts the turn if no stream progress —
      // text, reasoning, tool call, or stage — arrives within TIMEOUTS.llmStallMs,
      // catching a socket that stays open but stops delivering bytes. Together
      // these guarantee the turn can never hang the CLI indefinitely, even though
      // the shared engine path forwards only a bare abort signal.
      const turnController = makeTurnController(controller.signal);
      const stall = makeStallDetector(TIMEOUTS.llmStallMs, () => {
        if (!turnController.signal.aborted) {
          turnController.abort(
            new AgentTimeoutError("LLM stream stall", TIMEOUTS.llmStallMs),
          );
        }
      });

      // This turn's streamed messages (tool annotations + assistant text).
      const turn: Message[] = [];
      let assistantOpen = false;
      let reasoningOpen = false;
      const render = (): void => commit([...base, ...turn]);
      // Close any open streaming block (assistant prose or reasoning aside) so a
      // switch between the two — or a tool call in between — renders as a clean
      // break rather than concatenating into one run-on line.
      const closeStreamingBlocks = (): void => {
        if (assistantOpen || reasoningOpen) {
          const last = turn[turn.length - 1] as Message;
          turn[turn.length - 1] = { ...last, streaming: false };
        }
        assistantOpen = false;
        reasoningOpen = false;
      };

      // Project initialization and runTurn both live inside this try so the
      // finally below always restores the streaming UI state — otherwise a throw
      // from initializeProject (which runs before the model call) would leave the
      // thinking indicator stuck on forever.
      try {
        // Check if project needs initialization (first turn only)
        if (!isProjectInitialized(cwd) && turns === 0) {
          const initialized = await initializeProject({
            cwd,
            approver: (prompt) =>
              new Promise<boolean>((resolve) => {
                setApproval({
                  req: {
                    tool: "write_file",
                    summary: prompt,
                    reason: "Project initialization",
                    cwd,
                  },
                  resolve: (res) => {
                    resolve(res.decision === "allow");
                  },
                });
              }),
          });
          if (!initialized) {
            setApproval(null);
            pushAssistant("Project initialization skipped. Use .oxagen/settings.json to configure.");
            return;
          }
          setApproval(null);
        }

        void debugLog("turn", "turn.start", {
          mode: "repl",
          readOnly: modeRef.current === "readonly",
          model: modelRef.current,
          prompt: submission,
        });
        const result = await runTurn({
          prompt: submission,
          history: historyRef.current,
          workspace: createGatedWorkspace(
            workspaceRef.current,
            brokerRef.current ?? undefined,
          ),
          ai: aiRef.current,
          model: modelRef.current,
          effort: effortRef.current,
          readOnly: modeRef.current === "readonly",
          bare: bareRef.current,
          verbose: verboseRef.current,
          projectContext: projectContextRef.current,
          memory: createCombinedMemory(
            memoryRef.current,
            fleetMemoryRef.current,
          ),
          codeGraph: codeGraphRef.current,
          trace: traceStoreRef.current,
          graphSync: graphSyncRef.current,
          signal: turnController.signal,
          onStage: (stage) => {
            if (turnController.signal.aborted) return;
            stall.reset();
            void debugLog("turn", "turn.stage", { label: stage.label, detail: stage.detail });
            closeStreamingBlocks();
            turn.push({
              role: "stage",
              stage,
              content: stage.label,
              timestamp: Date.now(),
            });
            render();
          },
          onToolCall: (name, input) => {
            if (turnController.signal.aborted) return;
            stall.reset();
            void debugLog("turn", "turn.tool-call", { name, input });
            closeStreamingBlocks();
            turn.push({
              role: "tool",
              toolName: name,
              content: summarizeInput(name, input),
              timestamp: Date.now(),
            });
            render();
          },
          onReasoning: (delta) => {
            if (turnController.signal.aborted) return;
            stall.reset();
            // Reasoning and answer text interleave across steps — close the
            // assistant block when thinking resumes so they never merge.
            if (assistantOpen) closeStreamingBlocks();
            if (!reasoningOpen) {
              turn.push({
                role: "reasoning",
                content: "",
                streaming: true,
                timestamp: Date.now(),
              });
              reasoningOpen = true;
            }
            const last = turn[turn.length - 1] as Message;
            turn[turn.length - 1] = { ...last, content: last.content + delta };
            render();
          },
          onText: (delta) => {
            if (turnController.signal.aborted) return;
            stall.reset();
            streamCharsRef.current += delta.length;
            if (reasoningOpen) closeStreamingBlocks();
            if (!assistantOpen) {
              turn.push({
                role: "assistant",
                content: "",
                streaming: true,
                timestamp: Date.now(),
              });
              assistantOpen = true;
            }
            const last = turn[turn.length - 1] as Message;
            turn[turn.length - 1] = { ...last, content: last.content + delta };
            render();
          },
        });

        if (assistantOpen) {
          closeStreamingBlocks();
        } else {
          // Close any dangling reasoning block, then show the final answer text
          // (the model may have reasoned without emitting streamed prose).
          closeStreamingBlocks();
          turn.push({
            role: "assistant",
            content: result.text || "(done)",
            timestamp: Date.now(),
          });
        }
        render();
        historyRef.current = result.messages;
        // Debug mode: surface the exact prompt the model received after the
        // enhance stage (code-graph refs + recalled memory injected). This is
        // what the agent actually reasoned over, printed into the messages list
        // so the user can see how their prompt was transformed. Gated on the
        // same OXAGEN_CLI_DEBUG flag as the file log; skipped in bare mode where
        // no enhancement runs and the enhanced prompt equals the original.
        if (isDebugEnabled() && !bareRef.current) {
          const enhanced = result.trace.enhancement?.prompt;
          if (enhanced && enhanced !== submission) {
            turn.push({
              role: "reasoning",
              content: "debug · enhanced prompt sent to the model:\n" + enhanced,
              timestamp: Date.now(),
            });
            render();
          }
        }
        // The engine persists the turn trace via the injected `trace` port
        // (traceStoreRef), so /replay can show how it was handled — no explicit
        // record() needed here.
        // Verbose: stream the structured record to the JSONL log and show the
        // per-phase / per-model / cost breakdown inline.
        if (verboseRef.current) {
          appendVerboseLog(cwd, result.trace);
          turn.push({
            role: "assistant",
            content: formatVerboseSection(result.trace).join("\n"),
            timestamp: Date.now(),
          });
          render();
        }
        setTurns((n) => n + 1);
        setUsage((u) => ({
          input: u.input + (result.usage.inputTokens ?? 0),
          output: u.output + (result.usage.outputTokens ?? 0),
        }));
      } catch (err) {
        closeStreamingBlocks();
        // Distinguish the three exit paths: an explicit user cancel (Esc/Ctrl-C),
        // a timeout/stall (the turn deadline or stall detector fired on
        // turnController with a typed AgentTimeoutError reason), or a real error.
        const userCancelled = controller.signal.aborted;
        const timeoutReason: unknown = turnController.signal.aborted
          ? turnController.signal.reason
          : undefined;
        const content = userCancelled
          ? "(cancelled)"
          : timeoutReason instanceof AgentTimeoutError
            ? timeoutReason.message
            : `Error: ${err instanceof Error ? err.message : String(err)}`;
        turn.push({ role: "assistant", content, timestamp: Date.now() });
        render();
      } finally {
        stall.stop();
        abortRef.current = null;
        streamingRef.current = false;
        setIsStreaming(false);
        setTurnStartedAt(null);
      }
    },
    [exit, commit, pushAssistant, resetConversation, cwd, options.readOnly],
  );

  // The pump reads the latest handleSubmit via a ref so it never closes over a
  // stale version, while staying a stable callback itself.
  const handleSubmitRef = useRef(handleSubmit);
  handleSubmitRef.current = handleSubmit;

  // Single sequential consumer: drains the queue one prompt at a time, awaiting
  // each turn before starting the next. Re-entrancy is guarded so submissions
  // that arrive mid-drain just extend the queue the running pump is reading.
  const pump = useCallback(async () => {
    if (pumpingRef.current) return;
    pumpingRef.current = true;
    try {
      while (queueRef.current.length > 0) {
        const next = queueRef.current[0] as string;
        queueRef.current = queueRef.current.slice(1);
        setQueued(queueRef.current);
        try {
          await handleSubmitRef.current(next);
        } catch (err) {
          // A single failing turn must neither wedge the queue (leaving later
          // prompts undrained forever) nor escape as an unhandled rejection from
          // the `void pump()` call site. handleSubmit guards the model call
          // internally, but surface anything that still slips through and keep
          // draining the remaining prompts.
          pushAssistant(
            `Error: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } finally {
      pumpingRef.current = false;
    }
  }, [pushAssistant]);

  // Every submission goes through the queue. When idle, the pump picks it up
  // immediately; when a turn is in flight, it waits its turn (FIFO).
  const enqueue = useCallback(
    (text: string) => {
      queueRef.current = [...queueRef.current, text];
      setQueued(queueRef.current);
      void pump();
    },
    [pump],
  );

  return (
    // Fullscreen pins the column to the terminal height (alt screen); compact
    // leaves height unset so the conversation grows inline in the scrollback.
    <Box flexDirection="column" height={fullscreen ? rows : undefined}>
      {/* Header — the Oxagen ASCII wordmark. It animates (reveals top-to-bottom)
          the first time the REPL mounts, then stays as the logo header. */}
      <Banner version={pkg.version} animate />

      {/* Messages — fullscreen fills + clips to the screen; compact grows inline */}
      <Box
        flexDirection="column"
        flexGrow={fullscreen ? 1 : undefined}
        overflow={fullscreen ? "hidden" : undefined}
      >
        {messages.length === 0 ? (
          <Box paddingX={1} flexDirection="column">
            <Text dimColor>Ready. Type a prompt to start coding.</Text>
            <Text dimColor>
              Backed by Oxagen's knowledge-graph context engine. Type /help for
              commands.
            </Text>
            {projectContextRef.current.sources.length > 0 && (
              <Text dimColor>
                Loaded rules: {projectContextRef.current.sources.join(", ")}
              </Text>
            )}
          </Box>
        ) : (
          messages.map((msg, i) => <MessageView key={i} msg={msg} />)
        )}
      </Box>

      {/* Queued prompts (submitted while a turn is running) */}
      {queued.length > 0 && (
        <Box flexDirection="column" paddingX={1}>
          {queued.map((q, i) => (
            <Box key={i}>
              <Text color="#FBBF24">{"⧗ queued: "}</Text>
              <Text dimColor wrap="truncate">
                {q}
              </Text>
            </Box>
          ))}
        </Box>
      )}

      {/* Thinking indicator — visible only while a turn is in flight */}
      {isStreaming && turnStartedAt !== null && (
        <ThinkingIndicator
          startedAt={turnStartedAt}
          getTokens={() => Math.round(streamCharsRef.current / 4)}
        />
      )}

      {/* Status line */}
      <StatusLine
        model={model}
        readOnly={mode === "readonly"}
        turns={turns}
        inputTokens={usage.input}
        outputTokens={usage.output}
        pipelineOn={pipelineOn}
        verboseOn={verboseOn}
        mode={mode}
        tuiMode={tuiMode}
      />

      {/* Esc-twice reset confirmation — shown above the input row until the
          user types y/yes to confirm or anything else to cancel. */}
      {resetPending && (
        <Box paddingX={1} flexDirection="column">
          <Text color={theme.cyan}>
            Are you sure you want to reset the conversation?
          </Text>
          <Text dimColor>
            Type <Text bold>y</Text> or <Text bold>yes</Text> to confirm, or
            anything else (or Esc) to cancel.
          </Text>
        </Box>
      )}

      {/* A pending permission prompt takes over the input row; otherwise the
          input stays live during a turn and submissions queue (FIFO). */}
      {approval ? (
        <ApprovalPrompt req={approval.req} onResolve={resolveApproval} />
      ) : (
        <PromptInput
          onSubmit={enqueue}
          busy={isStreaming}
          catalog={catalogRef.current ?? []}
        />
      )}
    </Box>
  );
}

// ── Launch ────────────────────────────────────────────────────────────────────

export async function launchRepl(options: ReplOptions): Promise<void> {
  const { render: renderInk } = await import("ink");
  const { waitUntilExit } = renderInk(<ReplApp options={options} />);
  await waitUntilExit();
}
