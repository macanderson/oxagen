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
import { Box, Text, measureElement, useApp, useInput, type DOMElement } from "ink";
import React, { useState, useCallback, useRef, useEffect } from "react";
import type { ModelMessage } from "ai";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { theme } from "../tui/theme.js";
import { runTurn, type AgentAi } from "@oxagen/agent-engine";
import {
  createCwdWorkspace,
  createGatedWorkspace,
  createCombinedMemory,
  createCodeGraphProvider,
  createGraphSyncProvider,
  createPlatformAgentAi,
  createGatewayAgentAi,
} from "../agent/adapters/index.js";
import {
  prepareOnDeviceCoordinator,
  type OnDeviceCoordinator,
} from "../agent/adapters/on-device-agent-ai.js";
import { getCoordinator, setCoordinator } from "../runtime/config.js";
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
import { agentRegistry, type AgentHandle } from "../agent/agent-registry.js";
import { taskRegistry } from "../agent/task-registry.js";
import { isSubagentDispatch, subagentInfo } from "../agent/tool-formatter.js";
import {
  AgentSidebar,
  AgentFocusView,
  panelNavTargets,
  stepPanelFocus,
  SIDEBAR_MIN_COLS,
  type PanelMode,
  type PanelTarget,
} from "./agent-sidebar.js";
import { TerminalPanel, type TerminalRun } from "./terminal-panel.js";
import { runShellCommand as runShellCommand_impl, type ShellRunHandle } from "./shell-runner.js";
import { openTraceStore } from "../agent/trace-store.js";
import { appendVerboseLog } from "../agent/verbose-log.js";
import { formatVerboseSection } from "../agent/trace-format.js";
import { readConfig } from "../lib/config.js";
import { debugLog } from "../lib/debug-log.js";
import { formatToolArgs } from "../agent/tool-formatter.js";
import {
  ApprovalPrompt,
  CatMouseChase,
  HELP,
  MessageView,
  PromptInput,
  StatusLine,
  ThinkingIndicator,
  summarizeTrace,
  type Message,
} from "./components.js";
import { HudPanel } from "./hud.js";
import { resolveEscapeAction } from "./escape-action.js";
import { isDebugEnabled } from "../lib/debug-log.js";
import { Banner } from "../tui/banner.js";
import {
  useTerminalSize,
  ENTER_ALT_SCREEN,
  LEAVE_ALT_SCREEN,
  CURSOR_HOME,
} from "./use-terminal-size.js";
import {
  makeTurnController,
  makeStallDetector,
  AgentTimeoutError,
  DEFAULT_TIMEOUTS,
} from "../agent/timeouts.js";
import { createMetricsBus, type SessionMetrics } from "../agent/metrics.js";
import { createMeteredAi } from "../agent/metered-ai.js";
import {
  detectTerminalBackground,
  diffThemeFor,
} from "../tui/terminal-theme.js";
import {
  PermissionBroker,
  parseModeArg,
  resolveMode,
  persistedRuleString,
  type ApprovalRequest,
  type ApprovalResponse,
  type PermissionMode,
} from "../agent/permissions.js";
import { loadSettings } from "../settings/resolve.js";
import pkg from "../../package.json" with { type: "json" };

/**
 * How long a finished `!command`'s red live panel lingers before folding into
 * the transcript as a collapsed accordion. Long enough to read a quick result,
 * short enough that the red box never overstays into the next turn.
 */
const TERMINAL_FOLD_DELAY_MS = 6000;

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

/**
 * Ctrl-X double-press window (ms): a second Ctrl-X on the same panel row within
 * this window deletes it; otherwise the press just re-arms. Mirrors the
 * double-Esc reset window's "confirm by repeating" feel.
 */
const CTRL_X_WINDOW_MS = 1500;

/**
 * Best-effort current git branch by walking up from `cwd` to the nearest `.git`
 * and reading `HEAD`. No subprocess — just a file read — so it is cheap and safe.
 * Returns undefined outside a repo or on a detached HEAD.
 */
function readGitBranch(cwd: string): string | undefined {
  try {
    let dir = cwd;
    for (let i = 0; i < 64; i++) {
      const head = join(dir, ".git", "HEAD");
      if (existsSync(head)) {
        const ref = readFileSync(head, "utf8").trim();
        const m = ref.match(/^ref:\s*refs\/heads\/(.+)$/);
        return m ? m[1] : undefined; // detached HEAD → undefined
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* not a repo / unreadable — no branch chip */
  }
  return undefined;
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
  // Cumulative session usage (exact, from the model's reported usage): input /
  // output tokens, cache-read tokens (a "hit"), and estimated cost.
  const [usage, setUsage] = useState<{
    input: number;
    output: number;
    cacheHit: number;
    costUsd: number;
  }>({ input: 0, output: 0, cacheHit: 0, costUsd: 0 });
  // Live token/cost metrics (Bug 2). Every model call the engine makes flows
  // through the metered AI port, which records into this bus; the status line
  // subscribes and re-renders (throttled) as each call completes, then settles
  // on the final totals via flush() at turn end.
  const metricsBusRef = useRef(createMetricsBus());
  const [metrics, setMetrics] = useState<SessionMetrics>(() =>
    metricsBusRef.current.snapshot(),
  );
  useEffect(() => metricsBusRef.current.subscribe(setMetrics), []);
  // Cancel the terminal fold timer on unmount so it never fires setState on a
  // torn-down component.
  useEffect(() => () => {
    if (foldTimerRef.current) clearTimeout(foldTimerRef.current);
  }, []);
  // Timestamp of the last unit of turn progress (stream delta / stage / tool /
  // completed call). Drives the thinking indicator's idle figure and is the
  // signal the inactivity guard watches — the turn is bounded by PROGRESS, not
  // by a wall clock (Bug 1). A ref (not state) so streaming deltas don't thrash
  // React; the indicator polls it on its own 100ms tick.
  const lastProgressRef = useRef<number | null>(null);
  // Diff color theme, matched once to the terminal background (light diff on a
  // light terminal, dark on dark) — Feature C. Detection is cheap + synchronous.
  const diffThemeRef = useRef(diffThemeFor(detectTerminalBackground()));
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
  // Bumped every time a turn is interrupted (Esc/Ctrl-C). The pump captures the
  // generation it started under; when a cancel bumps it, the pump that was
  // awaiting the (now-cancelled) turn orphans itself instead of continuing to
  // drain — so a turn whose stream is slow to unwind on abort can never hold the
  // queue hostage. A fresh pump started by cancelTurn owns the drain from there.
  const pumpGenRef = useRef(0);
  // Stable handle to the pump, assigned once `pump` is defined below. Lets
  // cancelTurn (declared earlier) kick a fresh drain without a declaration-order
  // or stale-closure dependency.
  const pumpRef = useRef<(() => void) | null>(null);

  // Whether the eval→enhance→judge pipeline is active (vs. the bare agent).
  const [pipelineOn, setPipelineOn] = useState(!options.bare);
  const bareRef = useRef(options.bare ?? false);

  // Verbose telemetry: capture per-phase timing/model/cost + tool results, write
  // the JSONL stream, and show the breakdown inline. Defaults from config.
  const initialVerbose = options.verbose ?? readConfig().verbose ?? false;
  const [verboseOn, setVerboseOn] = useState(initialVerbose);
  const verboseRef = useRef(initialVerbose);
  // The REPL runs full-screen (alternate buffer; see launchRepl): the root box is
  // sized to the terminal so the prompt bar + status line stay pinned to the
  // bottom edge, while the transcript fills — and scrolls within — the space
  // above them. History is scrolled IN-APP (PgUp/PgDn drive scrollOffset) over a
  // rendered window of messages; the frame is clipped to the viewport so it never
  // grows taller than the terminal.
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
  // Current git branch for the status line (read once from .git/HEAD).
  const branchRef = useRef<string | undefined>(readGitBranch(cwd));
  // Engine ports — created once for the session. The workspace stays bare here;
  // it's wrapped with the permission broker (createGatedWorkspace) at call time
  // so /mode changes take effect without re-creating the workspace.
  const workspaceRef = useRef(createCwdWorkspace(cwd));
  // The base AI port, wrapped by the metered port so every engine model
  // call (evaluator, worker, judge) gets a per-call timeout + retry (Bug 1) and
  // records a priced metrics event for the live status line (Bug 2). Real
  // sessions route through the platform (metered server-side); the synthetic
  // benchmark session (OXAGEN_ALLOW_NO_SESSION=1) goes gateway-direct — a
  // synthetic token cannot authenticate against /v1/agent/llm.
  const aiRef = useRef(
    createMeteredAi(
      options.session.synthetic
        ? createGatewayAgentAi({ cwd })
        : createPlatformAgentAi({
            apiUrl: options.session.apiUrl,
            token: options.session.token,
            orgSlug: options.session.orgSlug,
            workspaceSlug: options.session.workspaceSlug,
          }),
      {
        onMetrics: (ev) => metricsBusRef.current.record(ev),
        onLog: (line) => void debugLog("timeout", line),
      },
    ),
  );
  // The AI port each turn actually runs on. Starts as the remote metered gateway
  // (`aiRef`); `/coordinator local` swaps it to the on-device port. `runTurn`
  // reads `activeAiRef.current` per turn, so a swap takes effect on the next turn
  // with no workspace re-creation.
  const activeAiRef = useRef<AgentAi>(aiRef.current);
  // The lazily-built local coordinator (loaded GGUF weights). Null until the
  // first `/coordinator local`; cached so re-toggling never reloads the weights.
  const localCoordinatorRef = useRef<OnDeviceCoordinator | null>(null);
  // Where the coordinator runs: "remote" (platform gateway) or "local" (on-device).
  // Persisted coordinator drives the initial label, but the active port always
  // starts remote so REPL boot never blocks on loading local weights.
  const [coordinatorLoc, setCoordinatorLoc] = useState<"remote" | "local">("remote");
  const coordinatorLocRef = useRef<"remote" | "local">("remote");
  coordinatorLocRef.current = coordinatorLoc;
  const codeGraphRef = useRef(
    createCodeGraphProvider((op, q, l) => queryCodeGraph(cwd, op, q, l)),
  );
  // Graph sync posts to the platform API — skip it for the synthetic
  // benchmark session (unauthenticated there, and bench runs shouldn't sync).
  const graphSyncRef = useRef(
    options.session.synthetic
      ? null
      : createGraphSyncProvider({ ...options.session, cwd }),
  );
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
  // Fleet memory (class + enforcement lessons) and the per-turn trace store, both synchronous.
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
  const approvalRef = useRef(approval);
  approvalRef.current = approval;

  // Whether we are showing the "reset conversation?" confirmation prompt.
  // The ref is the synchronous source of truth; the state drives the render.
  const [resetPending, setResetPending] = useState(false);
  const resetPendingRef = useRef(false);
  // Whether the `/hud` heads-up display (all running agents) is showing. The ref
  // mirrors the state so the synchronous Esc handler can read it without a stale
  // closure.
  const [hudVisible, setHudVisible] = useState(false);
  const hudVisibleRef = useRef(false);
  // Visibility of the right-hand Agent Team / Task Progress dock. "auto" shows it
  // only while a turn is monitoring work; /panel pins it "on" or hides it "off".
  const [panelMode, setPanelMode] = useState<PanelMode>("auto");
  const panelModeRef = useRef<PanelMode>("auto");
  // The `!command` terminal panel (red-outlined, pinned above the agent
  // messages). Null when no command has run this session. A `!cmd` submission
  // runs IMMEDIATELY — bypassing the turn queue so it works mid-turn — streaming
  // stdout/stderr live into this state. `terminalRunRef` mirrors it for the
  // synchronous key handler + streaming callbacks; `terminalHandleRef` holds the
  // live child process so Ctrl-C/Esc can kill it; `terminalIdRef` mints run ids.
  const [terminalRun, setTerminalRun] = useState<TerminalRun | null>(null);
  const terminalRunRef = useRef<TerminalRun | null>(null);
  terminalRunRef.current = terminalRun;
  const terminalHandleRef = useRef<ShellRunHandle | null>(null);
  const terminalIdRef = useRef(0);
  // After a `!command` finishes, its red live panel lingers briefly so the user
  // can read the result, then FOLDS: the pinned panel clears and the run drops
  // into the transcript as a collapsed, expandable accordion (see
  // foldTerminalInline). This timer drives that time-based hand-off.
  const foldTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // How far the transcript is scrolled back from the latest message, counted in
  // messages hidden below the fold. 0 = pinned to the newest output (the default,
  // auto-following as tokens stream in); PgUp raises it to reveal older history,
  // PgDown lowers it, and any new submission snaps it back to 0. The ref mirrors
  // the state so the synchronous key handler clamps against the live count.
  const [scrollOffset, setScrollOffset] = useState(0);
  const scrollOffsetRef = useRef(0);
  scrollOffsetRef.current = scrollOffset;
  // Live terminal geometry. `fullscreen` is true only on a real TTY; it gates
  // both the alternate-screen takeover (launchRepl) and sizing the root box to
  // the terminal so the prompt bar can pin to the bottom edge.
  const { rows, cols, fullscreen } = useTerminalSize();
  // Transcript overflow measurement: refs to the viewport and its inner content,
  // plus whether the content currently exceeds the viewport. When it does, the
  // transcript anchors its tail to the bottom (newest visible, older scrolls off
  // the top); when it fits, it anchors to the top so a short session reads
  // top-down with the empty space falling above the pinned prompt bar.
  const viewportRef = useRef<DOMElement | null>(null);
  const contentRef = useRef<DOMElement | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  // Re-measure the transcript against its viewport after every render (Ink lays
  // the tree out synchronously, so the measured sizes are current here). Only
  // flip `overflowing` when the boolean actually changes, so this settles in at
  // most one extra render and never loops. Skipped when not full-screen: without
  // a height-bounded root there is nothing to overflow.
  useEffect(() => {
    if (!fullscreen) return;
    const vp = viewportRef.current;
    const ct = contentRef.current;
    if (!vp || !ct) return;
    const next = measureElement(ct).height > measureElement(vp).height;
    setOverflowing((prev) => (prev === next ? prev : next));
  });
  // Timestamp of the most-recent Escape press (for the double-Esc detection
  // window). Null means no previous Esc has been recorded (or the window was
  // explicitly cleared after a 'prompt-reset' fires).
  const lastEscapeRef = useRef<number | null>(null);

  // ── Keyboard focus / side-panel navigation ──────────────────────────────────
  // Focus is either the prompt bar (the default) or a highlighted row in the
  // side panel. Down from the bar enters the panel (first Agent Team row); Up /
  // Down walk the flat Agent-Team-then-Task-Progress list; Up off the first row
  // (or Esc) returns to the bar. The ref is the synchronous source of truth the
  // key handler reads; the state drives the render (dimmed bar + highlighted row).
  type ReplFocus = { zone: "input" } | { zone: "agent" | "task"; id: string };
  const [focus, setFocusState] = useState<ReplFocus>({ zone: "input" });
  const focusRef = useRef<ReplFocus>({ zone: "input" });
  const setFocus = useCallback((next: ReplFocus): void => {
    focusRef.current = next;
    setFocusState(next);
  }, []);

  // The agent whose live log is pinned into the main conversation column (Ctrl-E
  // on an Agent Team row). Null = no log open. Cleared on Esc.
  const [focusedAgentId, setFocusedAgentIdState] = useState<string | null>(null);
  const focusedAgentIdRef = useRef<string | null>(null);
  const setFocusedAgentId = useCallback((id: string | null): void => {
    focusedAgentIdRef.current = id;
    setFocusedAgentIdState(id);
  }, []);

  // The task being edited (Ctrl-E on a Task Progress row loads its title into the
  // bar). While set, the next submit rewrites that task's title instead of
  // enqueuing a prompt. Null = the bar submits normal prompts.
  const [editingTaskId, setEditingTaskIdState] = useState<string | null>(null);
  const editingTaskIdRef = useRef<string | null>(null);
  const setEditingTaskId = useCallback((id: string | null): void => {
    editingTaskIdRef.current = id;
    setEditingTaskIdState(id);
  }, []);

  // Buffer-injection channel into PromptInput: bump the nonce to push `text` into
  // the (otherwise self-managed) input — recall the queue, load a task title, or
  // clear the bar. A monotonic ref makes each push distinct even for equal text.
  const [inject, setInject] = useState<{ text: string; nonce: number } | undefined>(undefined);
  const injectNonceRef = useRef(0);
  const injectText = useCallback((text: string): void => {
    injectNonceRef.current += 1;
    setInject({ text, nonce: injectNonceRef.current });
  }, []);

  // Whether PromptInput's slash-command menu is open. When it is, Up/Down belong
  // to the menu; when closed, they belong to focus navigation (recall / enter
  // panel). Mirrored into a ref so the synchronous key handler reads it fresh.
  const menuOpenRef = useRef(false);
  const handleMenuOpenChange = useCallback((open: boolean): void => {
    menuOpenRef.current = open;
  }, []);

  // Double-press tracker for Ctrl-X delete: the first press on a row arms; a
  // second press on the SAME row within the window deletes it. Switching rows
  // (or letting the window lapse) re-arms rather than firing.
  const lastCtrlXRef = useRef<{ id: string; at: number } | null>(null);

  // The permission broker, created once. Its approver surfaces an inline prompt
  // and resolves when the user answers (see ApprovalPrompt / resolveApproval).
  const brokerRef = useRef<PermissionBroker | null>(null);
  if (!brokerRef.current) {
    brokerRef.current = new PermissionBroker({
      mode: modeRef.current,
      cwd,
      // settings.json allow/deny (e.g. `Bash(*)` to auto-approve every shell
      // command, with `Bash(rm -rf*)` in deny still blocking it) so the broker
      // stops prompting for calls the user has already allow-listed.
      permissions: loadSettings({ cwd }).settings.permissions,
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
    // Interrupt the in-flight turn but KEEP anything queued behind it: the user
    // wants Esc to abandon the current turn and move on to the next queued
    // prompt (oldest first), not to wipe the whole queue. Prompts already
    // dequeued are gone; those still waiting drain next.
    // Release any pending permission prompt as a denial so the tool unblocks.
    approvalRef.current?.resolve({ decision: "deny" });
    setApproval(null);
    // Abort the turn signal. The engine throws on an aborted signal the moment
    // the current stream ends, and the stream callbacks below no-op once
    // aborted, so no late text renders.
    abortRef.current?.abort();
    // Return the UI to idle IMMEDIATELY so Esc feels instant even if the
    // underlying HTTP stream takes a moment to unwind. The turn's own finally
    // block also clears this state when the aborted promise finally settles.
    streamingRef.current = false;
    setIsStreaming(false);
    setTurnStartedAt(null);
    // Free the pump NOW. The aborted turn's runTurn may take a moment — or, if
    // the stream ignores the abort, a long time — to settle, and until it does
    // the pump would still be awaiting it and refuse (`pumpingRef`) to drain
    // anything new. Bump the generation so that stuck pump orphans itself,
    // release the guard, and kick a fresh pump to continue draining the queue
    // oldest-first (or sit idle, waiting for a new prompt, if it is empty).
    pumpGenRef.current += 1;
    pumpingRef.current = false;
    void pumpRef.current?.();
  }, []);

  /**
   * Run a `!command` immediately as a live terminal, bypassing the turn queue so
   * it works even while an agent turn is in flight. The user typed it explicitly,
   * so it runs directly in the workspace (not through the permission broker),
   * exactly like a shell. Output streams into the red terminal panel in real time
   * and — once finished — is fed into the model's history so the next turn sees
   * what the user ran and what it produced.
   */
  /**
   * Fold a finished run out of the pinned red panel and into the transcript as a
   * collapsed, expandable accordion — placed inline in chronological order with
   * the surrounding chat. Clears the pinned panel only if this run still owns it
   * (a newer command may already have taken the slot).
   */
  const foldTerminalInline = useCallback(
    (run: TerminalRun) => {
      if (foldTimerRef.current) {
        clearTimeout(foldTimerRef.current);
        foldTimerRef.current = null;
      }
      if (terminalRunRef.current?.id === run.id) {
        terminalRunRef.current = null;
        setTerminalRun(null);
      }
      commit([
        ...allRef.current,
        {
          role: "terminal",
          content: "",
          terminalRun: run,
          terminalExpanded: false,
          timestamp: run.endedAt ?? Date.now(),
        },
      ]);
    },
    [commit],
  );

  /**
   * Toggle the most recent folded terminal accordion open/closed (Ctrl-O). No-op
   * when no `!command` has folded into the transcript yet.
   */
  const toggleLatestTerminal = useCallback(() => {
    const next = [...allRef.current];
    for (let i = next.length - 1; i >= 0; i--) {
      const m = next[i];
      if (m && m.role === "terminal") {
        next[i] = { ...m, terminalExpanded: !m.terminalExpanded };
        commit(next);
        return;
      }
    }
  }, [commit]);

  const runShellCommand = useCallback(
    (raw: string) => {
      const command = raw.replace(/^!/, "").trim();
      if (!command) {
        pushAssistant("Usage: !<shell command> — runs it live in the workspace (works mid-turn).");
        return;
      }
      // A prior run still lingering in the red panel (finished, waiting to fold)
      // folds NOW so a new command never stacks a second live panel.
      const lingering = terminalRunRef.current;
      if (lingering && lingering.status !== "running") foldTerminalInline(lingering);
      // Only one terminal panel at a time: kill any command still running. Its
      // `.done` handler folds it inline once it's been superseded below.
      terminalHandleRef.current?.kill();

      const id = ++terminalIdRef.current;
      const startedAt = Date.now();
      let buf = "";
      const seed: TerminalRun = { id, command, output: "", status: "running", startedAt };
      terminalRunRef.current = seed;
      setTerminalRun(seed);

      // Coalesce chunks: chatty output would otherwise re-render Ink on every
      // write. Buffer and flush to state at most ~every 60ms; flush finally at end.
      let flushTimer: ReturnType<typeof setTimeout> | null = null;
      const flush = (): void => {
        flushTimer = null;
        if (terminalRunRef.current?.id !== id) return; // superseded by a newer run
        const next = { ...terminalRunRef.current, output: buf };
        terminalRunRef.current = next;
        setTerminalRun(next);
      };
      const scheduleFlush = (): void => {
        if (flushTimer == null) flushTimer = setTimeout(flush, 60);
      };

      const handle = runShellCommand_impl({
        command,
        cwd,
        onData: (chunk) => {
          buf += chunk;
          scheduleFlush();
        },
      });
      terminalHandleRef.current = handle;

      void handle.done.then((res) => {
        if (flushTimer != null) clearTimeout(flushTimer);
        if (terminalHandleRef.current === handle) terminalHandleRef.current = null;
        const status: TerminalRun["status"] = res.killed ? "killed" : "exited";
        const finished: TerminalRun = {
          id,
          command,
          output: buf,
          status,
          exitCode: res.exitCode,
          startedAt,
          endedAt: Date.now(),
        };
        // Make the model aware of what the user ran and what it produced.
        const body = buf.trimEnd() || "(no output)";
        historyRef.current = [
          ...historyRef.current,
          {
            role: "user",
            content:
              `I ran \`${command}\` in the shell (${res.timedOut ? "timed out" : `exit ${res.exitCode}`}). Output:\n` +
              body.slice(0, 4000),
          },
        ];
        if (terminalRunRef.current?.id === id) {
          // Still the pinned run: show the finished result in the red panel, then
          // fold it into the transcript after a short, readable linger.
          terminalRunRef.current = finished;
          setTerminalRun(finished);
          foldTimerRef.current = setTimeout(() => foldTerminalInline(finished), TERMINAL_FOLD_DELAY_MS);
        } else {
          // A newer command already took the panel (or killed us): drop straight
          // into the transcript so the run is never lost.
          foldTerminalInline(finished);
        }
      });
    },
    [commit, pushAssistant, cwd, foldTerminalInline],
  );

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

  // ── Side-panel navigation helpers ───────────────────────────────────────────
  // The flat nav order (Agent Team rows, then Task Progress rows) is recomputed
  // from the live registries at each keypress so it always matches what's drawn.
  const navTargets = useCallback(
    (): PanelTarget[] => panelNavTargets(agentRegistry.snapshot(), taskRegistry.snapshot()),
    [],
  );

  // Only move focus into the dock when it is actually docked (terminal wide
  // enough) AND has a row to land on — never strand the highlight off-screen.
  const panelReachable = useCallback((): boolean => {
    const cols = process.stdout.columns ?? 80;
    return cols >= SIDEBAR_MIN_COLS && navTargets().length > 0;
  }, [navTargets]);

  const setInputFocus = useCallback((): void => {
    setFocus({ zone: "input" });
    lastCtrlXRef.current = null;
  }, [setFocus]);

  // Down from the prompt bar: land on the first navigable row. No-op if the
  // panel isn't reachable (hidden or empty).
  const enterPanel = useCallback((): void => {
    if (!panelReachable()) return;
    const first = navTargets()[0];
    if (!first) return;
    setFocus(first);
    lastCtrlXRef.current = null;
  }, [navTargets, panelReachable, setFocus]);

  // Walk the flat list: +1 down, -1 up. Delegates the boundary math to the pure
  // stepPanelFocus — null means "return to the bar", the same ref means "stay".
  const movePanelFocus = useCallback(
    (dir: 1 | -1): void => {
      const cur = focusRef.current;
      if (cur.zone === "input") return;
      const next = stepPanelFocus(navTargets(), cur, dir);
      if (next === null) {
        setInputFocus();
      } else if (next !== cur) {
        setFocus(next);
        lastCtrlXRef.current = null;
      }
    },
    [navTargets, setFocus, setInputFocus],
  );

  // Up on the prompt bar (menu closed): pull EVERY queued prompt back into the
  // bar for editing (Claude Code-style), oldest first, and empty the queue.
  // No-op when nothing is queued.
  const recallQueue = useCallback((): void => {
    const q = queueRef.current;
    if (q.length === 0) return;
    const text = q.join("\n");
    queueRef.current = [];
    setQueued([]);
    injectText(text);
  }, [injectText]);

  // Ctrl-E on the highlighted row. Agent → pin its live log into the
  // conversation column and drop focus back into a freshly-cleared bar. Task →
  // load its title into the bar for editing (a submit then rewrites the task).
  const drillIn = useCallback((): void => {
    const cur = focusRef.current;
    if (cur.zone === "agent") {
      setFocusedAgentId(cur.id);
      setEditingTaskId(null);
      injectText(""); // always clear the bar as an agent takes focus
      setInputFocus();
    } else if (cur.zone === "task") {
      const task = taskRegistry.snapshot().find((t) => t.id === cur.id);
      if (!task) {
        setInputFocus();
        return;
      }
      setEditingTaskId(cur.id);
      setFocusedAgentId(null);
      injectText(task.title);
      setInputFocus();
    }
  }, [injectText, setEditingTaskId, setFocusedAgentId, setInputFocus]);

  // Ctrl-X on the highlighted row: first press arms; a second on the SAME row
  // within the window deletes it from its registry and re-homes focus onto the
  // next surviving row (or the bar).
  const handleCtrlX = useCallback((): void => {
    const cur = focusRef.current;
    if (cur.zone === "input") return;
    const now = Date.now();
    const prev = lastCtrlXRef.current;
    const armed = prev !== null && prev.id === cur.id && now - prev.at <= CTRL_X_WINDOW_MS;
    if (!armed) {
      lastCtrlXRef.current = { id: cur.id, at: now };
      return;
    }
    lastCtrlXRef.current = null;
    const idx = navTargets().findIndex((t) => t.zone === cur.zone && t.id === cur.id);
    if (cur.zone === "agent") agentRegistry.remove(cur.id);
    else taskRegistry.remove(cur.id);
    // Tear down any view tied to the deleted row.
    if (focusedAgentIdRef.current === cur.id) setFocusedAgentId(null);
    if (editingTaskIdRef.current === cur.id) {
      setEditingTaskId(null);
      injectText("");
    }
    const after = navTargets();
    const fallback = after.length === 0 ? null : after[Math.min(idx, after.length - 1)];
    if (fallback) setFocus(fallback);
    else setInputFocus();
  }, [navTargets, setFocus, setInputFocus, setFocusedAgentId, setEditingTaskId, injectText]);

  useInput((input, key) => {
    // Ctrl-C is handled first so it works even while a permission prompt is up
    // (cancelTurn releases the prompt as a denial before aborting). A live
    // `!command` takes priority: Ctrl-C kills it (like a real shell) rather than
    // cancelling the agent turn or quitting.
    if (key.ctrl && input === "c") {
      if (terminalRunRef.current?.status === "running") {
        terminalHandleRef.current?.kill();
      } else if (streamingRef.current && abortRef.current) {
        cancelTurn();
      } else {
        void memoryRef.current?.close();
        exit();
      }
      return;
    }
    // While a permission prompt is up, ApprovalPrompt owns Esc and the answer keys.
    if (approvalRef.current) return;

    // Ctrl-O expands/collapses the most recent folded `!command` accordion. Bound
    // before the focus-zone gate so it works whether focus is on the input or a
    // dock row.
    if (key.ctrl && input === "o") {
      toggleLatestTerminal();
      return;
    }

    // ── Side-panel navigation (focus is on a panel row) ──
    // While focus is in the dock, PromptInput's `focused` is false so it ignores
    // every key — this handler is the sole owner of arrows / Ctrl-E / Ctrl-X,
    // which avoids any same-keystroke double-processing race between the two.
    if (focusRef.current.zone !== "input") {
      if (key.escape) {
        setInputFocus();
        return;
      }
      if (key.upArrow) {
        movePanelFocus(-1);
        return;
      }
      if (key.downArrow) {
        movePanelFocus(1);
        return;
      }
      if (key.ctrl && input === "e") {
        drillIn();
        return;
      }
      if (key.ctrl && input === "x") {
        handleCtrlX();
        return;
      }
      // Every other key is swallowed while a panel row holds focus — the bar has
      // no focus, so stray characters must never leak into it or the transcript.
      return;
    }

    // Scrolling back through history is handled by the terminal's own scrollback
    // (the transcript is committed to it via <Static>), so the REPL does not bind
    // PageUp/PageDown/Ctrl-U/Ctrl-D — they pass through to the terminal.

    // ── Prompt-bar arrows (focus is on the input) ──
    // Only when the slash menu is CLOSED — while it's open the arrows navigate
    // suggestions inside PromptInput. Up recalls the queued prompts for editing;
    // Down moves focus into the Agent Team / Task Progress dock.
    if (!menuOpenRef.current) {
      if (key.upArrow) {
        recallQueue();
        return;
      }
      if (key.downArrow) {
        enterPanel();
        return;
      }
    }

    // Shift+Tab cycles the permission posture (ask → auto-edit → bypass →
    // read-only → …), mirroring Claude Code. The status line's second line
    // reflects the new mode immediately.
    if (key.tab && key.shift) {
      const order: PermissionMode[] = ["ask", "acceptEdits", "bypass", "readonly"];
      const idx = order.indexOf(modeRef.current);
      const next = order[(idx + 1) % order.length]!;
      setMode(next);
      brokerRef.current?.setMode(next);
      return;
    }

    // PgUp / PgDn scroll the transcript history within the full-screen viewport
    // (the app owns the screen now, so there is no native terminal scrollback to
    // defer to). PgUp reveals older messages; PgDn returns toward the latest.
    // Clamp to [0, count-1] so you can never scroll past the first message or
    // below the newest. Plain Up/Down stay owned by the prompt input's editing.
    if (key.pageUp || key.pageDown) {
      const step = 5;
      const maxOffset = Math.max(0, allRef.current.length - 1);
      setScrollOffset((o) => {
        const next = key.pageUp ? o + step : o - step;
        return Math.max(0, Math.min(maxOffset, next));
      });
      return;
    }

    if (key.escape) {
      // A live `!command` takes priority: Esc kills it (like Ctrl-C in a shell)
      // before it can interrupt a turn or seed a reset.
      if (terminalRunRef.current?.status === "running") {
        terminalHandleRef.current?.kill();
        lastEscapeRef.current = null;
        return;
      }

      // If the HUD is open, Esc just closes it — it never interrupts a turn or
      // seeds a reset. This is the lightest possible dismissal.
      if (hudVisibleRef.current) {
        hudVisibleRef.current = false;
        setHudVisible(false);
        lastEscapeRef.current = null;
        return;
      }

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

      // A task edit in progress: Esc abandons it and clears the bar rather than
      // stopping a turn or seeding a reset.
      if (editingTaskIdRef.current) {
        setEditingTaskId(null);
        injectText("");
        lastEscapeRef.current = null;
        return;
      }

      // A pinned agent log open in the conversation column: Esc closes it (back
      // to the plain transcript) before Esc means "stop" or "reset".
      if (focusedAgentIdRef.current) {
        setFocusedAgentId(null);
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

      // `!cmd` is intercepted synchronously in handleUserSubmit (it runs
      // immediately, bypassing this queue, so it works mid-turn) — it never
      // reaches the pump. Guard here too so a `!` that somehow slips through the
      // queue path is still handled rather than sent to the model as a prompt.
      if (text.startsWith("!")) {
        runShellCommand(text);
        return;
      }

      // ── Slash commands ──
      if (text === "/help") {
        pushAssistant(HELP);
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
      if (text === "/hud") {
        // Toggle the heads-up display of every agent running this session.
        const next = !hudVisibleRef.current;
        hudVisibleRef.current = next;
        setHudVisible(next);
        return;
      }
      if (text === "/panel") {
        // Pin/unpin the right-hand Agent Team / Task Progress dock. From "auto"
        // (or "off") the first toggle pins it "on"; toggling again hides it "off".
        const next: PanelMode = panelModeRef.current === "on" ? "off" : "on";
        panelModeRef.current = next;
        setPanelMode(next);
        pushAssistant(
          next === "on"
            ? "Agent panel pinned open (Agent Team · Task Progress). /panel to hide."
            : "Agent panel hidden. /panel to show it again.",
        );
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
      if (text.startsWith("/coordinator")) {
        const arg = text.slice("/coordinator".length).trim().toLowerCase();

        if (!arg) {
          const where =
            coordinatorLocRef.current === "local"
              ? `local on-device (${localCoordinatorRef.current?.modelId ?? "not yet loaded"})`
              : "remote platform gateway";
          const persisted = getCoordinator() === "on-device" ? "local" : "remote";
          pushAssistant(
            `Coordinator: ${coordinatorLocRef.current} — ${where}.\n` +
              `Persisted preference: ${persisted}. Use /coordinator remote|local.`,
          );
          return;
        }

        if (arg === "remote") {
          activeAiRef.current = aiRef.current;
          coordinatorLocRef.current = "remote";
          setCoordinatorLoc("remote");
          setCoordinator("haiku");
          pushAssistant(
            "Coordinator set to REMOTE — turns run on the metered platform gateway " +
              `(${modelRef.current}). /coordinator local to run fully on-device.`,
          );
          return;
        }

        if (arg === "local") {
          // Already loaded this session — just re-point the active port (no reload).
          if (localCoordinatorRef.current) {
            activeAiRef.current = localCoordinatorRef.current.ai;
            coordinatorLocRef.current = "local";
            setCoordinatorLoc("local");
            setCoordinator("on-device");
            pushAssistant(
              `Coordinator set to LOCAL — turns run on-device (${localCoordinatorRef.current.modelId}). ` +
                "No tokens leave your machine. /coordinator remote to switch back.",
            );
            return;
          }

          pushAssistant(
            "Preparing the on-device coordinator… first use downloads the model weights, " +
              "which can take a while.",
          );
          try {
            let lastPct = -1;
            const coord = await prepareOnDeviceCoordinator({
              onProgress: (received, total) => {
                if (!total) return;
                const pct = Math.floor((received / total) * 100);
                // Throttle to ~every 10% so we don't flood the transcript.
                if (pct >= lastPct + 10) {
                  lastPct = pct;
                  pushAssistant(`  downloading weights… ${pct}%`);
                }
              },
            });
            localCoordinatorRef.current = coord;
            activeAiRef.current = coord.ai;
            coordinatorLocRef.current = "local";
            setCoordinatorLoc("local");
            setCoordinator("on-device");
            pushAssistant(
              `Coordinator set to LOCAL — turns now run on-device (${coord.modelId}). ` +
                "No tokens leave your machine. Tool-calling on a local model is best-effort; " +
                "/coordinator remote to switch back.",
            );
          } catch (err) {
            // The runtime throws typed, actionable errors (dep missing / nothing
            // fits / not cached) — surface the guidance verbatim, stay on remote.
            pushAssistant(
              "Couldn't start the on-device coordinator (staying on remote):\n" +
                (err instanceof Error ? err.message : String(err)),
            );
          }
          return;
        }

        pushAssistant(`Unknown coordinator "${arg}". Use /coordinator remote|local.`);
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
            "Usage: /remember <text> — captures a memory (infers its class + kind) and saves it to the workspace graph.",
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
          const { listMemories, formatMemoryLines, MEMORY_CLASSES } = await import(
            "../lib/memory-client.js"
          );
          // The argument may be an epistemic class (OBSERVATION/RULE/FACT) or a
          // free-text content-domain kind — memoryKind is an open string, so
          // anything else is passed through verbatim as a kind filter.
          let memoryClass: (typeof MEMORY_CLASSES)[number] | undefined;
          let memoryKind: string | undefined;
          if (arg) {
            const upper = arg.toUpperCase();
            if (MEMORY_CLASSES.includes(upper as (typeof MEMORY_CLASSES)[number])) {
              memoryClass = upper as (typeof MEMORY_CLASSES)[number];
            } else {
              memoryKind = arg;
            }
          }
          pushAssistant(
            formatMemoryLines(await listMemories({ memoryClass, memoryKind, limit: 30 })),
          );
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
      // Reset the per-turn metrics totals; seed the progress clock.
      metricsBusRef.current.startTurn();
      lastProgressRef.current = Date.now();
      const controller = new AbortController();
      abortRef.current = controller;

      // Bound the turn by PROGRESS, not by a wall clock (Bug 1). The controller
      // fires only on user Esc/Ctrl-C — there is NO per-turn time cap, so a long
      // but healthy turn (hundreds of model calls, a worker→judge loop) runs to
      // completion. The inactivity guard aborts ONLY when no progress — a stream
      // delta, a stage, a tool call, a completed model call — lands within
      // turnInactivityMs (300s, larger than the longest tool timeout). Any
      // progress resets it. Per-model-call timeouts live in the metered AI port.
      const turnController = makeTurnController(controller.signal);
      const inactivityMs = DEFAULT_TIMEOUTS.turnInactivityMs ?? 300_000;
      const stall = makeStallDetector(inactivityMs, () => {
        if (!turnController.signal.aborted) {
          const idleMs = Date.now() - (lastProgressRef.current ?? Date.now());
          void debugLog("timeout", `[timeout] scope=turn reason=inactivity idle_ms=${idleMs}`);
          turnController.abort(new AgentTimeoutError("turn inactivity", inactivityMs));
        }
      });
      // Record progress: reset the inactivity guard AND advance the idle clock.
      const noteProgress = (): void => {
        stall.reset();
        lastProgressRef.current = Date.now();
      };

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

      // Registry handle for this turn, surfaced in `/hud`. Declared out here (not
      // in the try) so the finally can mark it done. Assigned only once we're past
      // project-init, so a skipped init never leaves a phantom "turn" in the HUD.
      let hudHandle: AgentHandle | null = null;
      // Subagents dispatched during this turn, surfaced in the Agent Team panel.
      // A tool call only tells us a subagent STARTED (MCP dispatch returns no
      // result here), so we mark each one done when the turn ends.
      const subagentHandles: AgentHandle[] = [];

      // Fresh Task Progress checklist for this turn: the pipeline's stages are the
      // planning agent's plan, recorded live as they run.
      taskRegistry.clear();
      /** Friendly, stable titles for each pipeline stage (the plan's steps). */
      const stageTitles: Record<string, string> = {
        evaluate: "Evaluate the request",
        enhance: "Enhance the prompt",
        route: "Route to a model",
        revise: "Revise incomplete work",
        execute: "Execute the work",
        judge: "Judge the result",
        complete: "Complete",
      };
      const recordStageTask = (kind: string, detail?: string): void => {
        if (kind === "complete") {
          taskRegistry.finalizeOpen("done");
          return;
        }
        // Stages run sequentially — close any other open step before opening this.
        for (const t of taskRegistry.snapshot()) {
          if (t.status === "in_progress" && t.id !== kind) {
            taskRegistry.update(t.id, { status: "done" });
          }
        }
        taskRegistry.upsert(kind, {
          title: stageTitles[kind] ?? kind,
          status: "in_progress",
          ...(detail !== undefined ? { detail } : {}),
        });
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
        // Surface this turn in the `/hud` heads-up display for its whole life.
        hudHandle = agentRegistry.register({
          kind: "turn",
          title: submission,
          model: modelRef.current,
        });
        const result = await runTurn({
          prompt: submission,
          history: historyRef.current,
          workspace: createGatedWorkspace(
            workspaceRef.current,
            brokerRef.current ?? undefined,
          ),
          ai: activeAiRef.current,
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
            noteProgress();
            void debugLog("turn", "turn.stage", { label: stage.label, detail: stage.detail });
            // Keep the HUD's live detail on the current stage.
            hudHandle?.update({ detail: stage.detail ?? stage.label });
            // Advance the Task Progress checklist to this stage.
            recordStageTask(stage.kind, stage.detail ?? undefined);
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
            noteProgress();
            void debugLog("turn", "turn.tool-call", { name, input });
            // A subagent dispatch joins the Agent Team panel for the rest of the
            // turn (marked done in the finally, since dispatch returns no result).
            if (isSubagentDispatch(name)) {
              const { slug, task } = subagentInfo(input);
              subagentHandles.push(
                agentRegistry.register({
                  kind: "subagent",
                  title: slug ?? "subagent",
                  ...(task !== undefined ? { detail: task } : {}),
                }),
              );
            }
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
            noteProgress();
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
            noteProgress();
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
          onFileChange: (diff, changedFiles) => {
            if (turnController.signal.aborted) return;
            noteProgress();
            // Render the code changes as a syntax-highlighted diff message, so
            // the user sees exactly what changed — themed to the terminal
            // background. Skip empty diffs (no textual change to show).
            if (!diff.trim()) return;
            closeStreamingBlocks();
            turn.push({
              role: "diff",
              content: "",
              diff,
              changedFiles,
              timestamp: Date.now(),
            });
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
        // End-of-turn summary card — the headline outcome, built only from data
        // the pipeline actually produced (advisor verdict + confidence, files
        // touched, priced cost). Shown when the turn did real work (touched
        // files, ran commands, or was judged); a pure Q&A reply gets no card so
        // casual chat stays uncluttered.
        {
          const t = result.trace;
          const judged = (t?.judgeRounds?.length ?? 0) > 0;
          const didWork =
            (t?.filesTouched?.length ?? 0) > 0 ||
            (t?.commandsRun?.length ?? 0) > 0 ||
            judged;
          if (t && didWork) {
            turn.push({
              role: "assistant",
              content: "",
              timestamp: Date.now(),
              summary: {
                complete: t.finalComplete,
                quality: judged ? t.judgeRounds[t.judgeRounds.length - 1]?.confidence : undefined,
                filesTouched: t.filesTouched ?? [],
                costUsd: t.usage?.costUsd ?? 0,
                judged,
              },
            });
            render();
          }
        }
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
        void debugLog("turn", "turn.end", {
          mode: "repl",
          steps: result.steps,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
        });
        setTurns((n) => n + 1);
        setUsage((u) => ({
          input: u.input + (result.usage.inputTokens ?? 0),
          output: u.output + (result.usage.outputTokens ?? 0),
          cacheHit: u.cacheHit + (result.usage.cachedInputTokens ?? 0),
          // The pipeline already priced the turn (rate card) onto the trace.
          costUsd: u.costUsd + (result.trace?.usage?.costUsd ?? 0),
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
        // Persist the exception to cli.output. The REPL previously only rendered
        // the error to the terminal — nothing reached the debug log, so a failed
        // or hung turn left only its `turn.tool-call`/agent messages behind with no
        // exception data to diagnose. A user cancel isn't an error, so skip it.
        if (!userCancelled) {
          void debugLog("error", "turn.error", {
            mode: "repl",
            kind: timeoutReason instanceof AgentTimeoutError ? "timeout" : "error",
            message: content.replace(/^Error: /, ""),
            // Pass the raw value so debugLog captures name/message/stack for a
            // thrown Error; the timeout reason's message is already user-facing.
            error: timeoutReason instanceof AgentTimeoutError ? timeoutReason.message : err,
          });
        }
        turn.push({ role: "assistant", content, timestamp: Date.now() });
        render();
      } finally {
        stall.stop();
        // This turn is over (success, error, or cancel) — retire its HUD entry.
        // It's this turn's own handle, so retiring it is safe even when an
        // overlapped later turn now owns the shared UI state guarded below.
        hudHandle?.done();
        // Retire this turn's subagents from the Agent Team panel. These are the
        // turn's own handles, so it's safe even under overlapped turns.
        for (const h of subagentHandles) h.done();
        // Only tear down SHARED turn/UI state if THIS turn still owns it. When a
        // turn is interrupted (Esc), the pump moves on to the next prompt right
        // away — so a cancelled turn's stream can settle here LONG after a newer
        // turn has already started and claimed `abortRef`. Guarding on ownership
        // stops that late finally from nulling the new turn's abort controller
        // (which would break Esc for it) or flipping the streaming UI off while
        // the new turn is still live. A turn that still owns `abortRef` is the
        // normal, non-overlapped case and tears down as before.
        if (abortRef.current === controller) {
          // Final flush so the status line settles on the correct final totals
          // and stays visible (Bug 2), even if the last few events were throttled.
          metricsBusRef.current.flush();
          lastProgressRef.current = null;
          abortRef.current = null;
          streamingRef.current = false;
          setIsStreaming(false);
          setTurnStartedAt(null);
          // Settle the Task Progress checklist so no step lingers half-lit. Guarded
          // on ownership so a cancelled turn's late finally never marks a newer
          // turn's freshly-cleared plan done.
          taskRegistry.finalizeOpen("done");
        }
      }
    },
    [exit, commit, pushAssistant, resetConversation, runShellCommand, cwd, options.readOnly],
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
    // The generation this pump owns. If an interrupt (cancelTurn) bumps it while
    // we are awaiting a turn, we are no longer the active pump: stop draining and
    // do not touch the guard, so the fresh pump cancelTurn started stays in
    // charge. Without this, a cancelled turn whose stream is slow to unwind would
    // keep this pump parked on its `await` and block every later prompt.
    const gen = pumpGenRef.current;
    try {
      while (pumpGenRef.current === gen && queueRef.current.length > 0) {
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
      // Only release the guard if we are still the current generation. An
      // orphaned pump (a cancel bumped the generation mid-await) must not clear a
      // newer pump's guard.
      if (pumpGenRef.current === gen) pumpingRef.current = false;
    }
  }, [pushAssistant]);
  pumpRef.current = pump;

  // Every submission goes through the queue. When idle, the pump picks it up
  // immediately; when a turn is in flight, it waits its turn (FIFO).
  const enqueue = useCallback(
    (text: string) => {
      queueRef.current = [...queueRef.current, text];
      setQueued(queueRef.current);
      // Snap the transcript back to the newest output whenever a fresh prompt is
      // submitted — a user who had scrolled up to read history expects the view
      // to follow their new turn rather than stay parked in the past.
      setScrollOffset(0);
      void pump();
    },
    [pump],
  );

  // Every PromptInput submission funnels through here. The Esc-twice reset
  // confirmation must be answered SYNCHRONOUSLY — if we let it fall through to
  // `enqueue`, the "y" lands in the FIFO behind any unwinding turn and is then
  // run as an ordinary prompt (it visibly shows as "⧗ queued: y") instead of
  // confirming the reset. Intercepting it here consumes the keystroke as the
  // answer the instant the user hits Enter, never touching the queue.
  const handleUserSubmit = useCallback(
    (text: string) => {
      // A task edit committed (Ctrl-E on a Task Progress row loaded its title):
      // rewrite that task's title instead of enqueuing a prompt, then return the
      // bar to normal. An empty submit simply cancels the edit.
      if (editingTaskIdRef.current) {
        const id = editingTaskIdRef.current;
        setEditingTaskId(null);
        const title = text.trim();
        if (title) {
          taskRegistry.update(id, { title });
          pushAssistant(`✎ Task updated: ${title}`);
        }
        return;
      }
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
      // `!cmd` runs IMMEDIATELY, bypassing the turn queue — so a terminal command
      // fires without delay even while an agent turn is streaming. It never joins
      // the FIFO (which would make it wait for the current turn to finish).
      if (text.startsWith("!")) {
        runShellCommand(text);
        return;
      }
      enqueue(text);
    },
    [enqueue, resetConversation, pushAssistant, setEditingTaskId],
  );

  // ── Full-screen transcript viewport ─────────────────────────────────────────
  // The REPL owns the whole screen (alternate buffer; see launchRepl). The root
  // box is sized to the live terminal so the prompt bar + status line can stay
  // PINNED to the bottom edge while the transcript fills — and scrolls within —
  // the space above them. Because the root is height-bounded and the transcript
  // viewport clips its overflow, the frame Ink redraws is never taller than the
  // terminal, which is exactly what kept the old inline model from garbling.
  //
  // Only a WINDOW of messages is rendered — enough to overflow the viewport a few
  // times over — so a long session never pays to re-render its whole history each
  // frame. `scrollOffset` (driven by PgUp/PgDn) slides that window back through
  // history; at offset 0 the window ends on the newest message and auto-follows.
  const totalMessages = messages.length;
  const windowEnd = Math.max(0, totalMessages - scrollOffset);
  const windowSize = Math.max(rows, 40);
  const windowStart = Math.max(0, windowEnd - windowSize);
  const windowMessages = messages.slice(windowStart, windowEnd);
  const scrolledBack = scrollOffset > 0;

  return (
    // Root — sized to the terminal only when we truly own a TTY (full-screen);
    // otherwise (tests / piped output) it stays auto-height and renders inline so
    // the component is trivially testable under ink-testing-library.
    <Box
      flexDirection="column"
      {...(fullscreen ? { height: rows, width: cols } : {})}
    >
      {/* Growing top region: the transcript (left, fills width) and the Agent
          Team / Task Progress dock (right). It flexGrows to consume everything
          above the pinned bottom stack; overflow="hidden" bounds it to the
          available rows so neither the transcript nor a tall sidebar can push the
          prompt bar off the bottom. */}
      <Box flexDirection="row" flexGrow={1} minHeight={0} overflow="hidden">
        <Box flexDirection="column" flexGrow={1} minWidth={0}>
          {/* Terminal panel — a `!command`'s live stdout/stderr, red-outlined and
              pinned just ABOVE the transcript so shell output stays visually
              separate from the agent speaking. Null until a command has run. */}
          {terminalRun && <TerminalPanel run={terminalRun} />}

          {/* Transcript viewport. It clips its overflow and anchors its content to
              the TOP while it fits (so a short session reads top-down with the gap
              falling between the last message and the pinned prompt) and to the
              BOTTOM once it overflows (so the newest output stays visible just
              above the prompt and older lines scroll off the top). `overflowing`
              is measured from the laid-out content vs. the viewport each frame. */}
          <Box
            ref={viewportRef}
            flexDirection="column"
            flexGrow={1}
            minHeight={0}
            overflow="hidden"
            justifyContent={overflowing ? "flex-end" : "flex-start"}
          >
            {/* Inner content keeps its natural height (flexShrink={0}) so the
                measurement reflects the true content size, not a squeezed one. */}
            <Box ref={contentRef} flexDirection="column" flexShrink={0}>
              {totalMessages === 0 ? (
                <Box paddingX={1} flexDirection="column">
                  <Banner version={pkg.version} />
                  <Text dimColor>Ready. Type a prompt to start coding.</Text>
                  <Text dimColor>
                    Backed by Oxagen's knowledge-graph context engine. Type /help
                    for commands.
                  </Text>
                  {projectContextRef.current.sources.length > 0 && (
                    <Text dimColor>
                      Loaded rules: {projectContextRef.current.sources.join(", ")}
                    </Text>
                  )}
                </Box>
              ) : (
                windowMessages.map((msg, i) => (
                  <MessageView
                    key={windowStart + i}
                    msg={msg}
                    diffTheme={diffThemeRef.current}
                  />
                ))
              )}
            </Box>
          </Box>
        </Box>

        {/* Right-hand dock: Agent Team (live roster) + Task Progress (the planning
            agent's checklist). Renders nothing until there's work to show.
            `focus` highlights the navigated-to row and `active` forces the dock
            visible while it holds focus, so arrow-nav / Ctrl-E drill-in / Ctrl-X
            never land on a hidden or unmarked list. */}
        <AgentSidebar
          mode={panelMode}
          focus={focus.zone === "input" ? null : focus}
          active={focus.zone !== "input"}
        />
      </Box>

      {/* Pinned bottom stack — everything here keeps its height (flexShrink={0})
          and sits flush against the bottom edge of the terminal: transient
          notices, then the input row, then the status line. */}
      <Box flexDirection="column" flexShrink={0}>
        {/* Scrolled-back-through-history hint */}
        {scrolledBack && (
          <Box paddingX={1}>
            <Text color="#FBBF24">⌃ history </Text>
            <Text dimColor>
              (PgDn to return to the latest{scrollOffset >= totalMessages - 1 ? " · at oldest" : ""})
            </Text>
          </Box>
        )}

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

      {/* Thinking indicator — visible only while a turn is in flight. */}
      {isStreaming && turnStartedAt !== null && (
        <ThinkingIndicator
          startedAt={turnStartedAt}
          getTokens={() => Math.round(streamCharsRef.current / 4)}
          getLastProgressAt={() => lastProgressRef.current}
        />
      )}

      {/* Esc-twice reset confirmation — shown above the input row until the user
          types y/yes to confirm or anything else to cancel. */}
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

      {/* Heads-up display — every agent running this session. Toggled by /hud
          (and closed by Esc); sits just above the input as a live status overlay. */}
      {hudVisible && <HudPanel />}

      {/* Drilled-in agent log — opened with Ctrl-E on an Agent Team row. It sits
          directly above the prompt bar (the bar is cleared and re-focused when
          it opens) and closes on Esc. Renders nothing once the agent is pruned. */}
      {focusedAgentId && <AgentFocusView agentId={focusedAgentId} />}

      {/* Task-edit hint — while editing a task title (Ctrl-E on a Task Progress
          row), Enter rewrites the task instead of sending a prompt. */}
      {editingTaskId && (
        <Box paddingX={1}>
          <Text color={theme.violet}>✎ Editing task — Enter saves the title, Esc cancels.</Text>
        </Box>
      )}

      {/* Input row — pinned to the bottom stack, padded above, and never allowed
          to shrink (flexShrink={0}) so the prompt bar keeps a constant height as
          the conversation above it grows or the terminal is resized.
          A pending permission prompt takes over the input row; otherwise the
          input stays live during a turn and submissions queue (FIFO). */}
      <Box marginTop={1} flexShrink={0} flexDirection="column">
        {approval ? (
          <ApprovalPrompt req={approval.req} onResolve={resolveApproval} />
        ) : (
          <PromptInput
            onSubmit={handleUserSubmit}
            busy={isStreaming}
            catalog={catalogRef.current ?? []}
            focused={focus.zone === "input"}
            inject={inject}
            onMenuOpenChange={handleMenuOpenChange}
          />
        )}

      {/* Status line — below the input bar, with a blank row beneath it so it is
          never flush against the bottom edge of the window. A whimsical cat
          chases a mouse on the rail above it while a turn is running (opt out
          with OXAGEN_CLI_FUN=0). */}
      <Box marginBottom={1} flexShrink={0} flexDirection="column">
        {process.env.OXAGEN_CLI_FUN !== "0" ? (
          <CatMouseChase active={isStreaming} />
        ) : null}
        <StatusLine
          model={model}
          branch={branchRef.current}
          // Tokens + cost come from the live metrics bus (every model call —
          // evaluator, worker, judge — contributes), so they update as calls
          // complete during a turn and settle correctly at the end (Bug 2).
          inputTokens={metrics.sessionTokensIn}
          outputTokens={metrics.sessionTokensOut}
          cacheHit={usage.cacheHit}
          cacheMiss={Math.max(0, metrics.sessionTokensIn - usage.cacheHit)}
          costUsd={metrics.sessionCostUsd}
          turnOutputTokens={metrics.turnTokensOut}
          turnCostUsd={metrics.turnCostUsd}
          pipelineOn={pipelineOn}
          verboseOn={verboseOn}
          effort={effort}
          mode={mode}
        />
      </Box>

      </Box>{/* end input row */}
      </Box>{/* end pinned bottom stack */}
    </Box>
  );
}

// ── Launch ────────────────────────────────────────────────────────────────────

export async function launchRepl(options: ReplOptions): Promise<void> {
  const { render: renderInk } = await import("ink");
  // Take over the screen so the prompt bar can pin to the bottom edge: switch to
  // the alternate buffer (which preserves the user's real terminal + scrollback
  // to restore on exit) BEFORE Ink's first paint, so no frame ever lands in the
  // normal buffer. Only on a real TTY — piped/redirected output (and tests) must
  // never emit these control sequences.
  const isTTY = Boolean(process.stdout.isTTY);
  // Restore the normal screen exactly once, however we exit (clean unmount, Esc,
  // Ctrl-C, or a hard signal), so the terminal is never left stuck in the alt
  // buffer. Guarded so double-invocation (finally + exit handler) is a no-op.
  let restored = false;
  const restore = (): void => {
    if (restored || !isTTY) return;
    restored = true;
    process.stdout.write(LEAVE_ALT_SCREEN);
  };
  if (isTTY) {
    process.stdout.write(ENTER_ALT_SCREEN + CURSOR_HOME);
    process.once("exit", restore);
  }
  try {
    const { waitUntilExit } = renderInk(<ReplApp options={options} />);
    await waitUntilExit();
  } finally {
    restore();
  }
}
