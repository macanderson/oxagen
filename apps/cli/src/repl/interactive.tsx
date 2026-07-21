/**
 * Interactive REPL — the default `oxagen` experience.
 *
 * Two render modes, chosen at launch by TTY detection (see `useTerminalSize` /
 * `launchRepl`):
 *   - FULL-SCREEN (a real TTY): takes over the alternate screen buffer and draws
 *     a dashboard (header · scrollable transcript viewport · dock) with its own
 *     in-app scroll (scroll.ts). The alt buffer has no scrollback, so committed
 *     rows stay in React state and are re-sliced each frame — NOT handed to
 *     `<Static>`.
 *   - INLINE (off a TTY: pipes, tests): renders in the terminal's normal screen
 *     buffer and commits finished turns to the terminal's own scrollback via
 *     Ink's `<Static>`, so scroll-up works natively like `less`.
 *
 * Common to both: a thinking indicator (spinner + elapsed + live token
 * estimate), a session token/cost status bar, multi-turn history + project
 * rules + Oxagen context-engine memory, and slash commands (/help, /model,
 * /clear, /exit) with a prompt queue and Esc / double Ctrl-C cancel.
 *
 * Only the in-progress turn + prompt bar + status/side panels re-render each
 * frame (see "Transcript rendering" below).
 *
 * Presentational pieces live in ./components; this file is the container.
 */
import { Box, Static, Text, useApp, useInput, useStdin } from "ink";
import React, {
  useState,
  useCallback,
  useRef,
  useEffect,
  useReducer,
  useMemo,
} from "react";
import type { ModelMessage } from "ai";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { theme } from "../tui/theme.js";
import {
  runTurn,
  type AgentAi,
  type StageEvent,
  type AskUserResponse,
} from "@oxagen/agent-engine";
import { SurveyPrompt } from "./survey-prompt.js";
import {
  createCwdWorkspace,
  createGatedWorkspace,
  createCombinedMemory,
  createServerMemory,
  createCodeGraphProvider,
  createPlatformAgentAi,
  createGatewayAgentAi,
} from "../agent/adapters/index.js";
import { resolveApiContext } from "../lib/api.js";
import {
  resolveCoordinatorAi,
  type ResolvedCoordinator,
} from "../agent/adapters/coordinator.js";
import { getCoordinator, setCoordinator } from "../runtime/config.js";
import { queryCodeGraph, warmCodeGraph } from "../agent/code-graph.js";
import type { Session } from "../lib/session.js";
import {
  resolveModelId,
  explicitModelId,
  resolveEffort,
  isReasoningEffort,
  EFFORT_LEVELS,
  type ReasoningEffort,
} from "../agent/model.js";
import { loadProjectContext } from "../agent/project-context.js";
import { loadAndExpand, parseInvocation } from "../slash/expand.js";
import { buildSlashCatalog, type SlashCatalogEntry } from "../slash/catalog.js";
import { describeCliCommands, type CliCommandMeta } from "../commands/meta.js";
import {
  isExternalOnlyCliCommand,
  isInlineDispatchableCliCommand,
  runInlineCliCommand,
  toShellCommand,
} from "./cli-bridge.js";
import { isProjectInitialized, initializeProject } from "../project/init.js";
import { openSessionMemory, type SessionMemory } from "../agent/memory.js";
import { openFleetMemory } from "../agent/fleet/memory.js";
import { openPlanStore } from "../agent/fleet/store.js";
import { loadAgents } from "../agents/loader.js";
import { planReplTurn, fallbackPlan } from "./plan-turn.js";
import { decideDispatch } from "./dispatch-mode.js";
import {
  createBackgroundTracker,
  type BackgroundTracker,
  type BackgroundRow,
} from "./background-tracker.js";
import { BackgroundPanel } from "./background-panel.js";
import {
  loadDispatchSettings,
  persistDispatchMode,
  persistDispatchCap,
  type DispatchSettings,
} from "./dispatch-settings.js";
import { openFleetStore } from "../sessions/store.js";
import { fleetRoot } from "../sessions/paths.js";
import { shortSid } from "../sessions/ids.js";
import { runFleetTurn } from "./fleet-turn.js";
import { agentRegistry, type AgentHandle } from "../agent/agent-registry.js";
import { taskRegistry } from "../agent/task-registry.js";
import { isSubagentDispatch, subagentInfo } from "../agent/tool-formatter.js";
import {
  AgentSidebar,
  AgentFocusView,
  panelNavTargets,
  hasFleetActivity,
  stepPanelFocus,
  SIDEBAR_MIN_COLS,
  type PanelMode,
  type PanelTarget,
} from "./agent-sidebar.js";
import {
  runShellCommand as runShellCommand_impl,
  type ShellRunHandle,
} from "../lib/shell-runner.js";
import { openTraceStore } from "../agent/trace-store.js";
import { appendVerboseLog } from "../agent/verbose-log.js";
import { formatVerboseSection } from "../agent/trace-format.js";
import {
  readConfig,
  getMotionMode,
  setMotionMode,
  type MotionMode,
} from "../lib/config.js";
import { debugLog } from "../lib/debug-log.js";
import { exitBySignal } from "../lib/exit-by-signal.js";
import { formatToolArgs } from "../agent/tool-formatter.js";
import {
  ApprovalPrompt,
  HELP,
  MessageView,
  PromptInput,
  SpaceInvaders,
  StatusLine,
  summarizeTrace,
  ThinkingIndicator,
  type Message,
} from "./components.js";
import { ScopeReview } from "./scope-review.js";
import type { ScopeReviewInfo, ScopeReviewDecision } from "../agent/trace.js";
import { HudPanel } from "./hud.js";
import { ConfigPanel } from "./config-panel.js";
import { DiffPanel } from "./diff-panel.js";
import { FilesPanel } from "./files-panel.js";
import { TasksPanel } from "./tasks-panel.js";
import { SwarmPanel } from "./swarm-panel.js";
import {
  MarketplacePanel,
  type MarketplaceClient as MarketplacePanelClient,
  type MarketplaceEntry as MarketplacePanelEntry,
} from "./marketplace-panel.js";
import {
  PromptsPanel,
  type SavedPrompt as PanelSavedPrompt,
} from "./prompts-panel.js";
import { CreateWizard, type CreateKind } from "./create-wizard.js";
import { loadPrompts, scaffoldPrompt } from "../prompts/index.js";
import { scaffoldSkill } from "../skills/index.js";
import { scaffoldCommand } from "../slash/write.js";
import { scaffoldAgent } from "../agents/write.js";
import {
  createMarketplaceClient,
  type MarketplaceEntry as LibMarketplaceEntry,
} from "../lib/marketplace.js";
import { triagePrompt } from "./triage.js";
import {
  createResourceMonitor,
  type ResourceMonitor,
} from "./resource-monitor.js";
import {
  recordTouch,
  normalizeTouchPath,
  type TouchOp,
  type TouchedFile,
} from "./files-touched.js";
import { openInEditor } from "./open-in-editor.js";
import { getFileDiff } from "./git-diff.js";
import { LoginPanel } from "./login-panel.js";
import type { InteractiveLoginResult } from "../commands/auth.js";
import type { PasteSubmission } from "./paste.js";
import { resolveEscapeAction } from "./escape-action.js";
import { resolveCtrlC, CTRL_C_EXIT_WINDOW_MS } from "./ctrl-c-action.js";
import { capTranscript, MAX_TRANSCRIPT_MESSAGES } from "./transcript-cap.js";
import { TerminalPanel, type TerminalRun } from "./terminal-panel.js";
import { isDebugEnabled, DEBUG_ENV, debugLogFile } from "../lib/debug-log.js";
import { Banner, bannerRowCount } from "../tui/banner.js";
import { useTerminalSize } from "./use-terminal-size.js";
import {
  scrollReducer,
  estimateMessageRows,
  INITIAL_SCROLL_STATE,
  type ScrollState,
  type ScrollAction,
  type ScrollCtx,
} from "./scroll.js";
import {
  createRenderThrottle,
  type RenderThrottle,
} from "./render-throttle.js";
import { telemetryReducer, INITIAL_TELEMETRY_STATE } from "./telemetry.js";
import {
  resolveModelRoles,
  persistRoleModel,
  type ModelRole,
} from "./model-roles.js";
import {
  borderPhaseFor,
  promptBorderColorFor,
  RAINBOW_FLASH_INTERVAL_MS,
} from "./border-phase.js";
import { inputContentRow } from "./mouse-select.js";
import {
  HeaderBar,
  TranscriptViewport,
  TelemetryDock,
  formatElapsed,
} from "./fullscreen-chrome.js";
import { useMouseWheel } from "./use-mouse-wheel.js";
import {
  enterFullscreen,
  suspendFullscreen,
  resumeFullscreen,
} from "./alt-screen.js";
import { resolveGitInfo } from "./git-info.js";
import { useRepoInfo } from "./use-repo-info.js";
import {
  createTurnRunner,
  AgentTimeoutError,
  resolveTurnInactivityMs,
} from "../agent/timeouts.js";
import { createCiWaitProbe } from "../lib/ci-wait.js";
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
// Subpath import, NOT the @oxagen/billing barrel: the barrel eagerly loads
// Stripe + drizzle + the whole billing surface (~400 ms measured), which would
// sit on the REPL's first-paint critical path for four small helpers.
import {
  createTurnBudgetGuard,
  formatBudgetUsd,
  TURN_BUDGET_MODES,
  TURN_BUDGET_OFF,
  type TurnBudgetPolicy,
  type TurnBudgetVerdict,
} from "@oxagen/billing/turn-budget";
import { parseBudgetCommand, describeBudgetModes } from "../agent/budget.js";
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
  /** Initial WORKER (executor) model — the tool loop. Set via `/worker-model` / `/model`. */
  model?: string;
  /** Initial JUDGE (advisor) model. Set via `/judge-model`. Undefined ⇒ engine default. */
  judgeModel?: string;
  /** Initial TRIAGE/coordinator (planner + evaluator) model. Set via `/triage-model`. */
  triageModel?: string;
  /** Initial reasoning effort for models that support it (low|medium|high). */
  effort?: string;
  readOnly?: boolean;
  /** Initial permission posture; defaults to `ask` (or `readonly` when readOnly). */
  mode?: PermissionMode;
  /** Start with the eval→enhance→judge pipeline disabled (bare agent). */
  bare?: boolean;
  /** Start in verbose mode: capture + emit full per-turn telemetry. */
  verbose?: boolean;
  /**
   * Initial per-turn dollar budget policy (from `--budget`/`--budget-mode`).
   * Session-scoped — no platform persistence; `/budget` changes it in place.
   * Undefined ⇒ off (unbounded turns), same as `TURN_BUDGET_OFF`.
   */
  budget?: TurnBudgetPolicy;
  /**
   * Factory for the full `oxagen` Commander tree — injected by the composition
   * root (program.tsx) so this module never imports it statically (that import
   * put the whole 2k-line command tree in the REPL's static graph). When
   * absent, `launchRepl` lazy-imports the real one; a ReplApp rendered
   * directly without it (component tests) just gets an empty CLI tier.
   */
  buildProgram?: () => import("commander").Command;
}

/**
 * One FIFO queue entry: the compact text as typed (transcript/HUD display)
 * plus, when the prompt held a paste placeholder, the resolved model-bound
 * data — expanded text and image attachments (see paste.ts). `paste` is
 * resolved once at submit time in PromptInput, so a prompt queued behind a
 * running turn still carries its full pasted content when it finally runs.
 */
interface QueuedPrompt {
  text: string;
  paste?: PasteSubmission;
}

/**
 * Imperative escape hatch for `launchRepl`'s SIGTERM/SIGINT handlers (see
 * below): a signal tears the process down without running React effect
 * cleanups, so there is no other way for the process-level handler to reach
 * ReplApp's live `abortRef`/`terminalHandleRef`/`renderThrottleRef` and abort
 * the in-flight turn + kill a live `!command` child before the process exits.
 * ReplApp populates `ref.current` on mount and clears it on unmount so a
 * signal arriving after teardown (or before mount) is a safe no-op.
 */
export interface ReplSignalHandle {
  /** Abort the in-flight turn, kill any live `!command` child, and cancel any pending render-throttle timer. Idempotent. */
  reapChildren: () => void;
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
 * The REPL fleet's configured concurrency ceiling (the orchestrator's own
 * default, stated explicitly because the resource monitor scales down FROM
 * this cap — see the runFleetTurn concurrencyProvider wiring).
 */
const FLEET_TURN_CONCURRENCY = 4;

/**
 * Isolates the 1Hz live-clock tick (header time-of-day, thinking-elapsed
 * readout, dock counters) so it invalidates ONLY the small subtree that
 * actually renders `now` — not the whole full-screen viewport. The clock used
 * to live as `ReplApp`-level state: every tick re-rendered the entire
 * component tree (transcript, sidebar, prompt bar and all), which is exactly
 * the kind of unrelated re-render the row-height memoization elsewhere in
 * this file is trying to avoid paying for. Each call site gets its OWN
 * `LiveClock` (and its own 1s timer) — three cheap intervals is a non-issue;
 * a full fullscreen re-render every second is not.
 */
function LiveClock({
  render,
}: {
  render: (now: number) => React.ReactElement;
}): React.ReactElement {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return render(now);
}

export function ReplApp({
  options,
  signalHandleRef,
}: {
  options: ReplOptions;
  /** See {@link ReplSignalHandle} — optional so ReplApp still renders standalone in tests. */
  signalHandleRef?: { current: ReplSignalHandle | null };
}): React.ReactElement {
  const { exit } = useApp();
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  // Idle Ctrl-C double-press: armed after the first press, cleared on exit,
  // on any resolving action, or after CTRL_C_EXIT_WINDOW_MS (see the Ctrl-C
  // handler + resolveCtrlC). While armed, a dim "press Ctrl-C again to exit"
  // hint renders above the prompt bar.
  const [ctrlCArmed, setCtrlCArmed] = useState(false);
  const lastCtrlCRef = useRef<number | null>(null);
  const ctrlCHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // WORKER model: null = "auto" — the engine's per-turn router picks the
  // cheapest sufficient tier (evaluator recommendation + the precise safety
  // floor for auth/billing/security/migration/architecture work). A non-null
  // slug is an explicit user pin (--model, OXAGEN_MODEL, `oxagen config
  // model`, or /worker-model) and is passed through verbatim — pinned wins.
  const [model, setModel] = useState<string | null>(
    explicitModelId(options.model) ?? null,
  );
  // Per-function model overrides (undefined ⇒ the engine's own default for that
  // role: advisor tier for judge, local heuristic / OXAGEN_LLM_EVALUATOR for
  // triage). Driven by /judge-model and /triage-model; threaded per turn.
  const [judgeModel, setJudgeModel] = useState<string | undefined>(
    options.judgeModel,
  );
  const [triageModel, setTriageModel] = useState<string | undefined>(
    options.triageModel,
  );
  // Reasoning effort for models that support a thinking mode (undefined = let
  // the model/server default decide). Driven by /effort; forwarded per turn.
  const [effort, setEffort] = useState<ReasoningEffort | undefined>(
    resolveEffort(options.effort),
  );
  // Per-turn dollar budget policy (session-scoped — see ReplOptions.budget).
  // Driven by --budget/--budget-mode at launch and /budget in-session; read
  // fresh per turn to build the createTurnBudgetGuard passed to runTurn.
  const [budgetPolicy, setBudgetPolicy] = useState<TurnBudgetPolicy>(
    options.budget ?? TURN_BUDGET_OFF,
  );
  const [turns, setTurns] = useState(0);
  // Live token/cost/cache metrics (Bug 2). Every model call the engine makes
  // — evaluator, worker (every step), judge — flows through the metered AI
  // port, which records into this bus; the dock/status line subscribe and
  // re-render (throttled) as each call completes, then settle on the final
  // totals via flush() at turn end. This is the SOLE source for session
  // token/cache/cost figures — a separate one-shot "settle at turn end" state
  // used to live here too and fed the same displays, which meant the cache
  // "hit" figure alone went stale mid-turn while tokens/cost next to it kept
  // updating live; removed in favor of this single, always-live source.
  const metricsBusRef = useRef(createMetricsBus());
  const [metrics, setMetrics] = useState<SessionMetrics>(() =>
    metricsBusRef.current.snapshot(),
  );
  useEffect(() => metricsBusRef.current.subscribe(setMetrics), []);
  // Cancel the terminal fold timer on unmount so it never fires setState on a
  // torn-down component.
  useEffect(
    () => () => {
      if (foldTimerRef.current) clearTimeout(foldTimerRef.current);
    },
    [],
  );
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
  // `paste` carries this prompt's expanded-text/image data (see paste.ts) —
  // resolved once at submit time in PromptInput, so it survives however long
  // the prompt waits in the FIFO before its turn actually runs.
  const [queued, setQueued] = useState<QueuedPrompt[]>([]);
  const queueRef = useRef<QueuedPrompt[]>([]);
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
  // The REPL renders INLINE (normal screen buffer, never the alternate buffer —
  // see launchRepl): finished messages commit to the terminal's own scrollback
  // via `<Static>`, so history scrolling is native (trackpad/mouse/Shift-PageUp),
  // not app-managed. Only the in-progress turn + prompt bar + status/side panels
  // re-render each frame, and that live frame is capped to the terminal height so
  // Ink's redraw never exceeds the viewport — see "Transcript rendering" below.
  // Permission posture (drives the broker + status chip) and the in-flight
  // approval request (drives the inline ApprovalPrompt; null when none).
  const [mode, setMode] = useState<PermissionMode>(
    options.mode ?? resolveMode({ readOnly: options.readOnly }),
  );
  const [approval, setApproval] = useState<{
    req: ApprovalRequest;
    resolve: (r: ApprovalResponse) => void;
  } | null>(null);

  // Pending ask_user clarification survey (drives the inline SurveyPrompt;
  // null when none). Same park-the-promise pattern as `approval`: the engine's
  // askUser callback stores the resolver here and the overlay resolves it
  // exactly once (choice, free text, or dismiss).
  const [pendingSurvey, setPendingSurvey] = useState<{
    question: string;
    options: string[];
    resolve: (r: AskUserResponse) => void;
  } | null>(null);

  // The active auth session — starts as the launch-time `options.session`
  // (synthetic bench/BYOK, or a real logged-in account) but a successful
  // inline `/login` (see the LoginPanel wiring + handleLoggedIn below)
  // replaces it, so a session that started synthetic/BYOK can pick up a real
  // Oxagen account without restarting the REPL. Read live wherever the
  // current org/workspace/token needs to be displayed (the header scope
  // chip); `aiRef`/`serverMemoryRef` below are one-time
  // `useRef` initializers keyed off the ORIGINAL `options.session` (mirroring
  // `/coordinator local`'s pattern), so `handleLoggedIn` additionally
  // reassigns `aiRef.current`/`activeAiRef.current` directly — reassigning a
  // ref's `.current` takes effect on the very next turn with no
  // re-initialization, exactly like the existing `/coordinator` swap.
  const [session, setSession] = useState<Session>(options.session);

  const cwd = process.cwd();
  // Current git branch for the status line (read once from .git/HEAD — or, in
  // a worktree, from the gitdir its `.git` pointer file names; see
  // git-info.ts). Full-screen mode's REPO panel additionally re-reads this
  // live via useRepoInfo below, since a `!git checkout` mid-session can
  // change it; this one-shot ref is what the classic inline StatusLine reads.
  const branchRef = useRef<string | undefined>(resolveGitInfo(cwd)?.branch);
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
  // The lazily-built local coordinator (loaded GGUF weights), resolved through
  // the runtime provider factory (see agent/adapters/coordinator.ts). Null until
  // the first `/coordinator local`; cached so re-toggling never reloads weights.
  const localCoordinatorRef = useRef<ResolvedCoordinator | null>(null);
  // Where the coordinator runs: "remote" (platform gateway) or "local" (on-device).
  // Persisted coordinator drives the initial label, but the active port always
  // starts remote so REPL boot never blocks on loading local weights.
  const [coordinatorLoc, setCoordinatorLoc] = useState<"remote" | "local">(
    "remote",
  );
  const coordinatorLocRef = useRef<"remote" | "local">("remote");
  coordinatorLocRef.current = coordinatorLoc;
  const codeGraphRef = useRef(
    createCodeGraphProvider((op, q, l) => queryCodeGraph(cwd, op, q, l)),
  );
  // Platform memory port — recall prior-session lessons + mirror new ones. Only
  // when authenticated and not a synthetic benchmark session; null degrades the
  // combined memory to local-only exactly as before. The kill switch
  // (OXAGEN_DISABLE_MEMORY=1) is enforced inside the combined adapter.
  const serverMemoryRef = useRef(
    options.session.synthetic || !resolveApiContext()
      ? null
      : createServerMemory({
          agentId: "coding-agent",
          executionRef: `cli:repl-${Date.now()}`,
          projectName: cwd.split("/").pop() || undefined,
        }),
  );
  // Project rules (CLAUDE.md/AGENTS.md) loaded once for the session.
  const projectContextRef = useRef(loadProjectContext(cwd));
  // Named agent roster (the per-turn planner assigns tasks to these) and the
  // durable plan store fleet turns persist their plans/tasks into.
  const agentsRef = useRef(loadAgents({ cwd }));
  const planStoreRef = useRef(openPlanStore(cwd));
  // Unified slash-command catalog — built-in REPL commands + every `oxagen --help`
  // command + custom .md commands. Powers the typeahead menu and the CLI-command
  // hints in handleSubmit. CLI introspection (buildProgram() — pure, no I/O) is
  // cached once; the custom-command tier is re-scanned each time the menu opens
  // (see handleMenuOpenChange) so a command file added mid-session shows up
  // without a restart. Held as state (not just a ref) so that re-scan re-renders
  // the menu; `catalogRef` mirrors it for the synchronous submit handler.
  const cliCommandsRef = useRef<ReadonlyArray<CliCommandMeta> | null>(null);
  if (!cliCommandsRef.current) {
    cliCommandsRef.current = options.buildProgram
      ? describeCliCommands(options.buildProgram())
      : [];
  }
  const [catalog, setCatalog] = useState<SlashCatalogEntry[]>(() =>
    buildSlashCatalog({ cwd, cliCommands: cliCommandsRef.current ?? [] }),
  );
  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;
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
  // The in-flight turn's render throttle (see render-throttle.ts): coalesces
  // this turn's rapid-fire `render()` calls onto a ~30fps commit cadence.
  // Held at component scope (not just inside handleSubmit's closure) so
  // cancelTurn and the unmount effect can reach in and cancel a pending
  // frame timer for whichever turn currently owns it.
  const renderThrottleRef = useRef<RenderThrottle<Message[]> | null>(null);
  const streamingRef = useRef(false);
  const modelRef = useRef(model);
  modelRef.current = model;
  const judgeModelRef = useRef(judgeModel);
  judgeModelRef.current = judgeModel;
  const triageModelRef = useRef(triageModel);
  triageModelRef.current = triageModel;
  const effortRef = useRef(effort);
  effortRef.current = effort;
  const budgetRef = useRef(budgetPolicy);
  budgetRef.current = budgetPolicy;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const approvalRef = useRef(approval);
  approvalRef.current = approval;
  // A budget-pause confirmation ("prompt" mode hit the limit — continue?").
  // Reuses the ApprovalPrompt overlay component (it only ever renders
  // req.reason/req.summary, never the tool/path/command fields) but keeps its
  // OWN state + resolve callback, separate from `approval`/`resolveApproval` —
  // that pathway persists "allow + remember" as a settings.json permission
  // rule, which makes no sense for a budget pause.
  const [budgetPause, setBudgetPause] = useState<{
    req: ApprovalRequest;
    resolve: (approved: boolean) => void;
  } | null>(null);
  const budgetPauseRef = useRef(budgetPause);
  budgetPauseRef.current = budgetPause;
  const resolveBudgetPause = useCallback((response: ApprovalResponse) => {
    const cur = budgetPauseRef.current;
    setBudgetPause(null);
    cur?.resolve(response.decision === "allow");
  }, []);

  // The pre-execution scope-review gate (the `confirmScope` setting). When the
  // engine reaches ROUTE and the setting is on, it awaits `confirmScope`, which
  // parks the promise resolver here and surfaces the ScopeReview overlay (same
  // takeover pattern as the permission/budget prompts). The overlay owns the
  // keyboard via its own useInput; `resolveScopeReview` is what it calls with
  // the user's Run / Edit / Cancel decision, closing the overlay and settling
  // the engine's awaited promise so EXECUTE proceeds, runs an edited prompt, or
  // cancels before any work. Null when no gate is pending.
  const [scopeReview, setScopeReview] = useState<{
    info: ScopeReviewInfo;
    resolve: (decision: ScopeReviewDecision) => void;
  } | null>(null);
  const scopeReviewRef = useRef(scopeReview);
  scopeReviewRef.current = scopeReview;
  const resolveScopeReview = useCallback((decision: ScopeReviewDecision) => {
    const cur = scopeReviewRef.current;
    setScopeReview(null);
    cur?.resolve(decision);
  }, []);

  // Verbose/expanded ("Ctrl-O") mode: render long prompts, the enhanced-prompt
  // scope card, and reasoning in FULL rather than a truncated preview. A ref
  // mirrors the state so the synchronous key handler flips it without a stale
  // closure; the state drives the re-render of the live frame.
  const [detailExpanded, setDetailExpanded] = useState(false);
  const detailExpandedRef = useRef(detailExpanded);
  detailExpandedRef.current = detailExpanded;

  // Short label of what the turn is doing RIGHT NOW (the in-flight stage or
  // tool), fed to the ThinkingIndicator's sub-10s heartbeat so a silent step
  // still tells the user what it's working on. A ref (not state) so updating it
  // on every stage/tool never thrashes React — the indicator polls it on its
  // own 100ms tick.
  const lastActivityRef = useRef<string | null>(null);

  // Whether we are showing the "reset conversation?" confirmation prompt.
  // The ref is the synchronous source of truth; the state drives the render.
  const [resetPending, setResetPending] = useState(false);
  const resetPendingRef = useRef(false);
  // Whether the `/hud` heads-up display (all running agents) is showing. The ref
  // mirrors the state so the synchronous Esc handler can read it without a stale
  // closure.
  const [hudVisible, setHudVisible] = useState(false);
  const hudVisibleRef = useRef(false);
  // ── Dispatch mode (docs/specs/repl-async-dispatch.md) ──────────────────────
  // When ON, a "task"-classified prompt is handed to a detached background
  // worker (composer frees immediately) instead of running inline; "simple"
  // lookups still answer inline. Seeded from the persisted settings tier once at
  // mount. The ref mirrors the state so the synchronous submit path reads it
  // without a stale closure.
  const dispatchInitRef = useRef<DispatchSettings | null>(null);
  if (dispatchInitRef.current === null) {
    dispatchInitRef.current = loadDispatchSettings(cwd);
  }
  const [dispatchMode, setDispatchMode] = useState<boolean>(
    dispatchInitRef.current.mode,
  );
  const dispatchModeRef = useRef(dispatchMode);
  dispatchModeRef.current = dispatchMode;
  const dispatchCapRef = useRef<number>(dispatchInitRef.current.maxConcurrent);
  // Plan-only mode (the /plan command). While ON, a submission runs ONLY the
  // planner: the decomposed task list renders for inspection (and stays pending
  // in the Task Progress panel) and nothing executes. `/plan run` re-submits
  // the last planned prompt with a one-shot bypass — planRunOverrideRef holds
  // that exact prompt text and is consumed by the plan gate when the pump
  // delivers it, so an unrelated queued prompt can never steal the bypass.
  const [planOnly, setPlanOnly] = useState(false);
  const planOnlyRef = useRef(planOnly);
  planOnlyRef.current = planOnly;
  const lastPlanOnlyRef = useRef<string | null>(null);
  const planRunOverrideRef = useRef<string | null>(null);
  // Late-bound resubmission seam: /plan run needs `enqueue`, which is defined
  // after handleSubmit (the pump). Assigned every render once enqueue exists.
  const resubmitRef = useRef<(text: string) => void>(() => {});
  // ── Takeover panels: Ctrl+T tasks · Ctrl+S swarm · /marketplace · /prompts ·
  // /create-* wizard. Same open-ref pattern as /config below (each panel owns
  // the keyboard via its own useInput; the central handler yields on the ref).
  // The openers below keep them mutually exclusive.
  const [tasksOpen, setTasksOpen] = useState(false);
  const tasksOpenRef = useRef(false);
  const [swarmOpen, setSwarmOpen] = useState(false);
  const swarmOpenRef = useRef(false);
  const [marketplaceOpen, setMarketplaceOpen] = useState(false);
  const marketplaceOpenRef = useRef(false);
  const [promptsOpen, setPromptsOpen] = useState(false);
  const promptsOpenRef = useRef(false);
  const [promptsList, setPromptsList] = useState<PanelSavedPrompt[]>([]);
  const [createKind, setCreateKind] = useState<CreateKind | null>(null);
  const createKindRef = useRef<CreateKind | null>(null);
  const closeOverlayPanels = useCallback((): void => {
    tasksOpenRef.current = false;
    setTasksOpen(false);
    swarmOpenRef.current = false;
    setSwarmOpen(false);
    marketplaceOpenRef.current = false;
    setMarketplaceOpen(false);
    promptsOpenRef.current = false;
    setPromptsOpen(false);
    createKindRef.current = null;
    setCreateKind(null);
  }, []);
  const toggleTasksPanel = useCallback((): void => {
    const next = !tasksOpenRef.current;
    closeOverlayPanels();
    tasksOpenRef.current = next;
    setTasksOpen(next);
  }, [closeOverlayPanels]);
  const toggleSwarmPanel = useCallback((): void => {
    const next = !swarmOpenRef.current;
    closeOverlayPanels();
    swarmOpenRef.current = next;
    setSwarmOpen(next);
  }, [closeOverlayPanels]);
  const openCreateWizard = useCallback(
    (kind: CreateKind): void => {
      closeOverlayPanels();
      createKindRef.current = kind;
      setCreateKind(kind);
    },
    [closeOverlayPanels],
  );
  // Global (input-zone) Ctrl-X double-press: kill the newest running agent.
  const globalCtrlXRef = useRef<{ id: string; at: number } | null>(null);
  // The /marketplace panel's data seam — the live plugin-catalog client behind
  // the panel's own narrower interface. Entries seen by browse() are cached by
  // id so install(id) can recover the pluginType the install capability needs.
  // useState initializer (not useMemo/useRef) guarantees the referential
  // stability MarketplacePanel requires of its `client` prop.
  const [marketplaceClient] = useState<MarketplacePanelClient>(() => {
    const real = createMarketplaceClient();
    const seen = new Map<string, LibMarketplaceEntry>();
    return {
      browse: async (opts) => {
        const res = await real.browseCatalog(opts);
        if (!res.ok) throw new Error(res.error);
        const entries: MarketplacePanelEntry[] = res.data.entries.map((e) => {
          seen.set(e.id, e);
          return { ...e, title: e.title ?? undefined };
        });
        return {
          entries,
          total: res.data.total,
          nextOffset: res.data.nextOffset,
        };
      },
      install: async (id) => {
        const entry = seen.get(id);
        if (!entry) return { ok: false, error: "unknown plugin id" };
        const res = await real.installPlugin({
          pluginType: entry.pluginType,
          id,
        });
        return res.ok ? { ok: true } : { ok: false, error: res.error };
      },
    };
  });
  // Machine-aware swarm sizing: free memory + load average clamp the effective
  // background-dispatch and fleet concurrency (see resource-monitor.ts).
  const resourceMonitorRef = useRef<ResourceMonitor | null>(null);
  if (resourceMonitorRef.current === null) {
    resourceMonitorRef.current = createResourceMonitor();
  }
  // Observer for the dispatches this REPL spawned (fold-back + concurrency cap).
  const trackerRef = useRef<BackgroundTracker | null>(null);
  // Prompts waiting for a background slot when the cap is hit (local queue, so
  // we never spawn unbounded workers). Drained as dispatches complete.
  const dispatchQueueRef = useRef<string[]>([]);
  const drainRef = useRef<() => void>(() => {});
  const [backgroundRows, setBackgroundRows] = useState<BackgroundRow[]>([]);
  // The /config panel — takes over the input row while open (same pattern as
  // ApprovalPrompt) and owns the keyboard via its own useInput; the central
  // handler below yields to it through this ref (read synchronously, so no
  // stale closure). Closed with Esc inside the panel.
  const [configOpen, setConfigOpen] = useState(false);
  const configOpenRef = useRef(false);
  const closeConfigPanel = useCallback((): void => {
    configOpenRef.current = false;
    setConfigOpen(false);
  }, []);
  // The Ink-native `/login` panel (PR C item 12) — same takeover pattern as
  // the /config panel above. `handleLoggedIn` (defined below, once the AI
  // port refs exist) is declared separately so this block stays adjacent to
  // its /config sibling.
  const [loginOpen, setLoginOpen] = useState(false);
  const loginOpenRef = useRef(false);
  const closeLoginPanel = useCallback((): void => {
    loginOpenRef.current = false;
    setLoginOpen(false);
  }, []);
  // The /diff panel — same takeover pattern as /config: it owns the keyboard
  // via its own useInput while open, and the central handler yields through
  // diffOpenRef. `diffInitialPath` lets `/diff <path>` open straight into a file.
  const [diffOpen, setDiffOpen] = useState(false);
  const diffOpenRef = useRef(false);
  const [diffInitialPath, setDiffInitialPath] = useState<string | undefined>(
    undefined,
  );
  const closeDiffPanel = useCallback((): void => {
    diffOpenRef.current = false;
    setDiffOpen(false);
  }, []);
  // The /files "Files Touched" panel — same takeover pattern as /diff. The
  // STORE lives in filesTouchedRef and accumulates across every turn of the
  // session: reads from read_file tool calls, creates/updates from the
  // engine's per-edit file-edit events, deletes detected at hydrate time
  // (git status "D" / vanished from disk). touchVersion bumps re-render the
  // panel while it's open so rows appear live as the agent works.
  const [filesOpen, setFilesOpen] = useState(false);
  const filesOpenRef = useRef(false);
  const closeFilesPanel = useCallback((): void => {
    filesOpenRef.current = false;
    setFilesOpen(false);
  }, []);
  const filesTouchedRef = useRef<Map<string, TouchedFile>>(new Map());
  const touchSeqRef = useRef(0);
  const [, setTouchVersion] = useState(0);
  const noteTouch = useCallback(
    (path: string, op: TouchOp): void => {
      recordTouch(
        filesTouchedRef.current,
        path,
        op,
        cwd,
        ++touchSeqRef.current,
      );
      if (filesOpenRef.current) setTouchVersion((v) => v + 1);
    },
    [cwd],
  );
  // Enter/→ in the Files Touched panel hands off to the /diff panel, opened
  // straight on the selected file (one diff implementation, not two).
  const showDiffForTouched = useCallback((path: string): void => {
    filesOpenRef.current = false;
    setFilesOpen(false);
    setDiffInitialPath(path);
    diffOpenRef.current = true;
    setDiffOpen(true);
  }, []);
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
  // Zombie-process guard: nothing previously aborted an in-flight turn or
  // killed a live `!command` child on unmount. If ReplApp is torn down mid-turn
  // (a fatal render error elsewhere, a test harness unmount, or — with the
  // SIGTERM/SIGINT handlers added in launchRepl — a signal-driven exit that
  // unmounts the Ink tree) the model call kept streaming into a dead
  // component and any detached `bash -c` process group (see shell-runner.ts)
  // kept running with no one left to reap it. Abort the turn, kill the
  // terminal child, and cancel any pending render-throttle frame timer so it
  // can never fire a `setState` after teardown.
  const reapChildren = useCallback((): void => {
    abortRef.current?.abort();
    terminalHandleRef.current?.kill();
    renderThrottleRef.current?.cancel();
  }, []);
  useEffect(() => {
    // Publish the reaper for launchRepl's SIGTERM/SIGINT handlers (see
    // ReplSignalHandle) — populated on mount, cleared on unmount so a signal
    // arriving before mount / after teardown is a safe no-op rather than
    // calling into a stale closure.
    if (signalHandleRef) signalHandleRef.current = { reapChildren };
    return () => {
      reapChildren();
      if (signalHandleRef) signalHandleRef.current = null;
      if (ctrlCHintTimerRef.current) clearTimeout(ctrlCHintTimerRef.current);
    };
  }, [signalHandleRef, reapChildren]);
  // Live terminal geometry. `fullscreen` is true only on a real TTY: it gates
  // BOTH the classic inline mode's live-frame height cap (see "Transcript
  // rendering" below) AND the full-screen TUI layout (header/viewport/dock) —
  // see the render branch at the bottom of this component. Off a TTY (tests,
  // pipes) the REPL always takes the classic inline path, unchanged.
  const { rows, cols, fullscreen } = useTerminalSize();
  // Mirror `fullscreen` into a ref so `commit` (a stable useCallback) can decide
  // whether trimming the transcript is safe without re-creating on every resize.
  // Only full-screen mode may trim (see transcript-cap.ts / commit below).
  const fullscreenRef = useRef(fullscreen);
  fullscreenRef.current = fullscreen;

  // ── Full-screen TUI state (used only when `fullscreen` is true) ────────────
  // In-app scroll position over the transcript viewport — the alternate
  // screen buffer has no scrollback of its own, so this replaces it. `ctx`
  // (total content rows + viewport height) is mirrored into a ref rather than
  // stored in state — same "latest value" pattern as modelRef/effortRef below
  // — so the bound reducer always clamps against the CURRENT content size
  // without needing an extra dispatch to "catch up" after new content streams
  // in (see scroll.ts's effectiveOffset).
  const scrollCtxRef = useRef<ScrollCtx>({ totalLines: 0, viewportHeight: 1 });
  const boundScrollReducer = useCallback(
    (state: ScrollState, action: ScrollAction) =>
      scrollReducer(state, action, scrollCtxRef.current),
    [],
  );
  const [scrollState, dispatchScroll] = useReducer(
    boundScrollReducer,
    INITIAL_SCROLL_STATE,
  );
  // Live per-turn/session telemetry for the MODELS/TURN/TOOLS dock panels,
  // fed from the SAME onStage/onToolCall callbacks the transcript already
  // renders from (see the runTurn call in handleSubmit below). Token/cost
  // numbers come straight from `metrics` above — this reducer only tracks
  // what that doesn't already have (model slugs, phase/step/round, tool
  // tallies).
  // Seed the MODELS readout eagerly: worker/judge/planner are all resolvable
  // from defaults + overrides at mount, so the user sees which models will run
  // BEFORE the first prompt — stage events overwrite with actuals mid-turn.
  const [telemetry, dispatchTelemetry] = useReducer(
    telemetryReducer,
    INITIAL_TELEMETRY_STATE,
    (initial) => ({
      ...initial,
      models: resolveModelRoles(explicitModelId(options.model) ?? "auto", {
        triage: options.triageModel,
        judge: options.judgeModel,
      }),
    }),
  );
  // Prompt-input border color, animated through the turn lifecycle (see
  // border-phase.ts): derived from the SAME telemetry.turn.phase the TURN
  // dock panel reads above, rather than a second dispatched phase, so the
  // two displays can never drift apart — turn-start already sets phase to
  // "evaluate", onStage advances it to whatever stage runs next, and turn-end
  // sets it to "complete", which is exactly submit -> evaluate -> active ->
  // idle. `flashTick` only ticks while evaluating (the rainbow flash); the
  // interval is torn down the instant the phase moves on so a flash from a
  // finished turn can never bleed into the next one.
  const borderPhase = borderPhaseFor(telemetry.turn.phase);
  // Animation level (/motion): "full" = everything, "reduced" = no decorative
  // animation (invaders duel, prompt border flash), "off" = reduced plus the
  // thinking indicator. Persisted in ~/.config/oxagen/config.json; mirrored
  // into a ref because handleSubmit is memoized without it as a dep (same
  // pattern as mouseOnRef below).
  const [motion, setMotion] = useState<MotionMode>(() => getMotionMode());
  const motionRef = useRef(motion);
  const [flashTick, setFlashTick] = useState(0);
  useEffect(() => {
    // The rainbow flash is decorative — only tick it at full motion.
    if (borderPhase !== "evaluating" || motion !== "full") return;
    const timer = setInterval(
      () => setFlashTick((t) => t + 1),
      RAINBOW_FLASH_INTERVAL_MS,
    );
    return () => clearInterval(timer);
  }, [borderPhase, motion]);
  const promptBorderColor = promptBorderColorFor(
    borderPhase,
    flashTick,
    motion,
  );
  // Whether the prompt bar is empty — gates Up/Down/Home/End between
  // transcript-scroll (bar empty) and their normal recall-queue / panel-entry
  // / cursor meaning (bar has text). Mirrored from PromptInput's onEmptyChange.
  const inputEmptyRef = useRef(true);
  // Mouse-wheel transcript scroll — default OFF, opt in with /mouse (or
  // OXAGEN_CLI_MOUSE=1). It stays off by default on purpose: arming SGR mouse
  // reporting makes the terminal stream click/drag/wheel escape sequences to
  // this app, which DISABLES the emulator's own text selection and can leak
  // those escape bytes into a copied selection (the "garbled copy/paste" bug).
  // Leaving it off means drag-to-select + Cmd/Ctrl-C just work natively and
  // copies come out clean; keyboard scroll (PageUp/PageDown, Ctrl-U/Ctrl-D,
  // Up/Down/Home/End on an empty bar) covers scrolling without the wheel. Turn
  // it on only if you specifically want wheel/trackpad scroll and accept losing
  // native selection while it's armed — see use-mouse-wheel.ts.
  const [mouseOn, setMouseOn] = useState(process.env.OXAGEN_CLI_MOUSE === "1");
  // `/mouse` is handled inside `handleSubmit`, a `useCallback` whose deps don't
  // include `mouseOn` — reading the state directly there would close over
  // whatever `mouseOn` was when that callback was last memoized, so `!mouseOn`
  // would keep recomputing the SAME flip forever (toggle ON→OFF then stuck OFF).
  // Mirror it into a ref (same pattern as hudVisibleRef/panelModeRef above) so
  // the handler always reads the latest value.
  const mouseOnRef = useRef(mouseOn);
  const handleWheel = useCallback((direction: "up" | "down") => {
    dispatchScroll({ type: direction === "up" ? "line-up" : "line-down" });
  }, []);
  useMouseWheel(handleWheel, fullscreen && mouseOn);
  // Mouse click/drag text selection in the prompt input (see
  // components.tsx's PromptInput + use-mouse-select.ts): the SAME
  // `fullscreen && mouseOn` gate as the wheel above, since SGR tracking is
  // only ever armed in fullscreen mode (see enterFullscreen/useMouseWheel) —
  // `mouseRow` is the input's on-screen content row, undefined (disabling
  // click/drag mapping) in classic mode where that geometry doesn't apply.
  const promptMouseRow = fullscreen ? inputContentRow(rows) : undefined;
  const promptMouseEnabled = fullscreen && mouseOn;
  // The 1Hz clock (header time-of-day + dock elapsed counters) used to live
  // here as top-level state: every tick re-rendered the WHOLE ReplApp tree,
  // including the transcript viewport and sidebar. It's now isolated into the
  // <LiveClock> component below (used at each of its 3 call sites) so a tick
  // invalidates only that small subtree.
  // REPO dock panel: worktree path, live branch (re-read periodically — a
  // `!git checkout` mid-session changes it), and PR number (async via `gh`,
  // cached, never blocking). Full-screen only — see use-repo-info.ts.
  const repoInfo = useRepoInfo(cwd, fullscreen);
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
  const [focusedAgentId, setFocusedAgentIdState] = useState<string | null>(
    null,
  );
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
  const [inject, setInject] = useState<
    { text: string; nonce: number } | undefined
  >(undefined);
  const injectNonceRef = useRef(0);
  const injectText = useCallback((text: string): void => {
    injectNonceRef.current += 1;
    setInject({ text, nonce: injectNonceRef.current });
  }, []);

  // Clear the armed "press Ctrl-C again to exit" hint and its auto-dismiss timer.
  const clearCtrlCHint = useCallback((): void => {
    if (ctrlCHintTimerRef.current) {
      clearTimeout(ctrlCHintTimerRef.current);
      ctrlCHintTimerRef.current = null;
    }
    setCtrlCArmed(false);
  }, []);
  // Show the hint and auto-dismiss it once the double-press window lapses, so a
  // lone idle Ctrl-C leaves no lingering banner.
  const armCtrlCHint = useCallback((): void => {
    setCtrlCArmed(true);
    if (ctrlCHintTimerRef.current) clearTimeout(ctrlCHintTimerRef.current);
    ctrlCHintTimerRef.current = setTimeout(() => {
      ctrlCHintTimerRef.current = null;
      lastCtrlCRef.current = null;
      setCtrlCArmed(false);
    }, CTRL_C_EXIT_WINDOW_MS);
  }, []);

  // Whether PromptInput's slash-command menu is open. When it is, Up/Down belong
  // to the menu; when closed, they belong to focus navigation (recall / enter
  // panel). Mirrored into a ref so the synchronous key handler reads it fresh.
  const menuOpenRef = useRef(false);
  const handleMenuOpenChange = useCallback(
    (open: boolean): void => {
      // On the closed→open transition, re-scan user-defined commands so a file
      // dropped into .oxagen/commands (or ~/.config/oxagen/commands) mid-session
      // appears immediately. CLI introspection is cached (cliCommandsRef) — only
      // the cheap custom-command fs scan inside buildSlashCatalog re-runs.
      if (open && !menuOpenRef.current) {
        setCatalog(
          buildSlashCatalog({ cwd, cliCommands: cliCommandsRef.current ?? [] }),
        );
      }
      menuOpenRef.current = open;
    },
    [cwd],
  );
  // Mirrors PromptInput's buffer-empty state into inputEmptyRef (declared
  // above with the other full-screen state) so the synchronous key handler
  // can gate Up/Down/Home/End without re-rendering on every keystroke.
  const handleEmptyChange = useCallback((empty: boolean): void => {
    inputEmptyRef.current = empty;
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
        new Promise<ApprovalResponse>((resolve) =>
          setApproval({ req, resolve }),
        ),
    });
  }

  useEffect(() => {
    // Warm the code-graph in the background at mount so the FIRST turn's enhance
    // stage hits a built graph instead of paying a cold tree-sitter build on the
    // critical path (previously the first prompt of a session ate that build).
    warmCodeGraph(cwd);
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
    // Bound transcript memory on very long full-screen sessions. Inline mode
    // commits finished rows through Ink's append-only `<Static>`, which drops
    // the newest row if the fed array is trimmed (see transcript-cap.ts), so it
    // is intentionally left uncapped there; full-screen keeps everything in
    // React state and re-slices a visible window each frame, so dropping the
    // oldest rows is safe and also bounds the O(N) row-height pass. Model
    // history (historyRef) is bounded separately by the engine's token-budget
    // compaction, so it needs no cap here.
    const capped = fullscreenRef.current
      ? capTranscript(next, MAX_TRANSCRIPT_MESSAGES)
      : next;
    allRef.current = capped;
    setMessages(capped);
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

  // Double-Ctrl-O in the Files Touched panel: open the highlighted file in
  // $VISUAL/$EDITOR (or the OS default app). GUI editors detach and return
  // immediately; a terminal editor (vim, nano, …) must own the TTY, so the
  // REPL suspends around a blocking run — leave the alt screen (fullscreen
  // only), drop raw mode, hand stdio to the editor, restore both on exit.
  const { stdin: rawStdin, setRawMode } = useStdin();
  const openTouchedInEditor = useCallback(
    (relPath: string): void => {
      const abs = isAbsolute(relPath) ? relPath : join(cwd, relPath);
      const result = openInEditor(abs, {
        suspendTui: () => {
          if (fullscreen) suspendFullscreen(process.stdout);
          if (rawStdin.isTTY) setRawMode(false);
        },
        resumeTui: () => {
          if (rawStdin.isTTY) setRawMode(true);
          if (fullscreen) resumeFullscreen(process.stdout);
        },
      });
      pushAssistant(
        result.ok
          ? `Opened ${relPath} in ${result.label}.`
          : `Couldn't open ${relPath}: ${result.error}`,
      );
    },
    [cwd, fullscreen, pushAssistant, rawStdin, setRawMode],
  );

  // Double-Ctrl-V in the prompt bar (see PromptInput's onOpenLastTouched):
  // open the agent's most recently touched file in $VISUAL/$EDITOR. "Most
  // recent" = highest firstSeq in the Files Touched store — the same
  // chronological order the /files panel lists.
  const openLastTouchedInEditor = useCallback((): void => {
    const entries = [...filesTouchedRef.current.values()];
    if (entries.length === 0) {
      pushAssistant(
        "Ctrl-V twice opens the agent's most recently touched file — none touched yet this session. /files browses them once a turn runs.",
      );
      return;
    }
    const latest = entries.reduce((a, b) => (b.firstSeq > a.firstSeq ? b : a));
    openTouchedInEditor(latest.path);
  }, [pushAssistant, openTouchedInEditor]);

  // /prompts — load fresh from disk on every open so newly-authored prompts
  // appear without a restart (three small dirs; cheap).
  const openPromptsPanel = useCallback((): void => {
    const loaded: PanelSavedPrompt[] = [...loadPrompts({ cwd }).values()].map(
      (p) => ({ name: p.name, description: p.description, body: p.body }),
    );
    closeOverlayPanels();
    setPromptsList(loaded);
    promptsOpenRef.current = true;
    setPromptsOpen(true);
  }, [cwd, closeOverlayPanels]);

  const openMarketplacePanel = useCallback((): void => {
    closeOverlayPanels();
    marketplaceOpenRef.current = true;
    setMarketplaceOpen(true);
  }, [closeOverlayPanels]);

  // The /create-* wizard's filesystem seam: kind → the real scaffolder.
  const scaffoldForKind = useCallback(
    (kind: CreateKind, name: string): { path: string; created: boolean } => {
      switch (kind) {
        case "command":
          return scaffoldCommand({ name, cwd });
        case "agent":
          return scaffoldAgent({ name, cwd });
        case "skill":
          return scaffoldSkill({ name, cwd });
        case "prompt":
          return scaffoldPrompt({ name, cwd });
      }
    },
    [cwd],
  );
  const handleCreated = useCallback(
    (path: string): void => {
      // A newly-scaffolded custom command must appear in the / menu right
      // away — rebuild the catalog from disk.
      setCatalog(
        buildSlashCatalog({ cwd, cliCommands: cliCommandsRef.current ?? [] }),
      );
      pushAssistant(
        `✚ Created ${path} — edit the template, then use it immediately (custom commands reload per open of the / menu).`,
      );
    },
    [cwd, pushAssistant],
  );

  // Resource-monitor lifecycle: announce pressure transitions (the moment the
  // machine can't carry the configured swarm, say so and by how much), and
  // stop the sampler on unmount. The clamp itself is enforced at the dispatch
  // gate and the fleet's concurrencyProvider — this effect is the narrator.
  useEffect(() => {
    const mon = resourceMonitorRef.current;
    if (!mon) return;
    const off = mon.onChange((snap) => {
      if (snap.pressure === "ok") return;
      const eff = mon.effectiveConcurrency(dispatchCapRef.current);
      pushAssistant(
        `⚖ Machine pressure ${snap.pressure} — free memory ${(snap.freeMemRatio * 100).toFixed(0)}%, ` +
          `load ${snap.load1.toFixed(1)} on ${snap.cores} cores. Swarm concurrency clamped to ${eff} until it eases.`,
      );
    });
    return () => {
      off();
      mon.stop();
    };
  }, [pushAssistant]);

  // Orphan auto-resume (crash-proof state, ADR-023/028): shortly after mount,
  // scan this project's fleet roster for sessions whose owner process died
  // mid-run and fork each back to life at its last settled turn — work
  // survives a crashed worker without being restarted from scratch. Deferred
  // off the mount critical path and dynamically imported (commands/fleet.ts is
  // heavy); strictly best-effort — failure must never affect the REPL.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const [{ adoptOrphans }, { handleFleetResume }, { captureWriter }] =
            await Promise.all([
              import("../sessions/adopt.js"),
              import("../commands/fleet.js"),
              import("../lib/capture-writer.js"),
            ]);
          const result = await adoptOrphans({
            cwd,
            resume: async (sid) => {
              const { writer, output } = captureWriter();
              // handleFleetResume flips process.exitCode on usage errors —
              // never let a background adoption change the REPL's exit code.
              const savedExitCode = process.exitCode;
              try {
                await handleFleetResume(
                  sid,
                  { turn: "last", json: true, quiet: true, cwd },
                  writer,
                );
              } finally {
                process.exitCode = savedExitCode;
              }
              const lines = output().trim().split("\n").filter(Boolean);
              const parsed = JSON.parse(lines[lines.length - 1] ?? "{}") as {
                sid?: string;
              };
              if (!parsed.sid) throw new Error("resume emitted no session id");
              return parsed.sid;
            },
          });
          if (!cancelled && result.adopted.length > 0) {
            const n = result.adopted.length;
            pushAssistant(
              `↻ Recovered ${n} orphaned session${n === 1 ? "" : "s"} from a dead worker — ` +
                result.adopted
                  .map(
                    (a) => `${a.sid.slice(0, 10)} → ${a.newSid.slice(0, 10)}`,
                  )
                  .join(", ") +
                ". Each resumes at its last settled turn; watch with Ctrl+S or oxagen fleet ps.",
            );
          }
        } catch {
          // Best-effort recovery only — never surface a failure here.
        }
      })();
    }, 1500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [cwd, pushAssistant]);

  // Called once by the LoginPanel (see the /login handler below) on a
  // successful inline login. The session is already persisted to
  // ~/.config/oxagen/config.json by `runBrowserLogin` at that point — this
  // just updates what's live in THIS running REPL process: the header scope
  // chip (`session` state) and, if the coordinator hasn't been switched to
  // on-device (`/coordinator local`), the AI port turns actually run on.
  // Reassigning `.current` takes effect starting the very next turn with no
  // workspace re-creation — the exact same mechanism `/coordinator` uses.
  // NOTE: platform memory (`serverMemoryRef`) is NOT hot-swapped here. It is a
  // one-time `useRef` initializer keyed by executionRef, so it picks up a
  // freshly logged-in session on the next `oxagen` launch.
  // That's a real, intentional limitation of this pass — the AI port swap
  // covers what a user doing `/login` mid-session cares about most (running
  // turns against their real account), and is called out in the PR.
  const handleLoggedIn = useCallback(
    (result: InteractiveLoginResult): void => {
      const nextSession: Session = {
        token: result.token,
        orgSlug: result.orgSlug,
        workspaceSlug: result.workspaceSlug,
        apiUrl: options.session.apiUrl,
      };
      setSession(nextSession);
      const platformAi = createMeteredAi(createPlatformAgentAi(nextSession), {
        onMetrics: (ev) => metricsBusRef.current.record(ev),
        onLog: (line) => void debugLog("timeout", line),
      });
      aiRef.current = platformAi;
      if (coordinatorLocRef.current === "remote") {
        activeAiRef.current = platformAi;
      }
      pushAssistant(
        "✓ Logged in — this session now runs turns against your Oxagen account. " +
          "Graph sync and platform memory pick up on the next `oxagen` launch.",
      );
    },
    [options.session.apiUrl, pushAssistant],
  );

  const cancelTurn = useCallback(() => {
    // Interrupt the in-flight turn but KEEP anything queued behind it: the user
    // wants Esc to abandon the current turn and move on to the next queued
    // prompt (oldest first), not to wipe the whole queue. Prompts already
    // dequeued are gone; those still waiting drain next.
    // Release any pending permission prompt as a denial so the tool unblocks.
    approvalRef.current?.resolve({ decision: "deny" });
    setApproval(null);
    // Release a pending scope-review gate as a cancel so the engine's awaited
    // confirmScope promise settles and the turn unwinds cleanly.
    scopeReviewRef.current?.resolve({ proceed: false });
    setScopeReview(null);
    // Abort the turn signal. The engine throws on an aborted signal the moment
    // the current stream ends, and the stream callbacks below no-op once
    // aborted, so no late text renders.
    abortRef.current?.abort();
    // Cancel (don't flush) any pending render-throttle frame timer: the turn's
    // own `finally` still runs its final untrottled flush once the aborted
    // stream actually settles, so there is nothing to lose by dropping a
    // frame that was only ever going to re-render the same, now-stale content.
    renderThrottleRef.current?.cancel();
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
        pushAssistant(
          "Usage: !<shell command> — runs it live in the workspace (works mid-turn).",
        );
        return;
      }
      // A prior run still lingering in the red panel (finished, waiting to fold)
      // folds NOW so a new command never stacks a second live panel.
      const lingering = terminalRunRef.current;
      if (lingering && lingering.status !== "running")
        foldTerminalInline(lingering);
      // Only one terminal panel at a time: kill any command still running. Its
      // `.done` handler folds it inline once it's been superseded below.
      terminalHandleRef.current?.kill();

      const id = ++terminalIdRef.current;
      const startedAt = Date.now();
      let buf = "";
      const seed: TerminalRun = {
        id,
        command,
        output: "",
        status: "running",
        startedAt,
      };
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
        if (terminalHandleRef.current === handle)
          terminalHandleRef.current = null;
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
          foldTimerRef.current = setTimeout(
            () => foldTerminalInline(finished),
            TERMINAL_FOLD_DELAY_MS,
          );
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
    (): PanelTarget[] =>
      panelNavTargets(agentRegistry.snapshot(), taskRegistry.snapshot()),
    [],
  );

  // Only move focus into the dock when it is actually ON SCREEN (terminal wide
  // enough, not hidden by mode/auto) AND has a row to land on — never strand the
  // highlight off-screen. Mirrors AgentSidebar's own visibility test so Down can
  // never open (or fail to reach) a dock the render just decided to hide: with
  // `auto`, that means the dock must have real fleet activity (hasFleetActivity);
  // `/panel on` pins it reachable, `/panel off` makes it unreachable.
  const panelReachable = useCallback((): boolean => {
    const cols = process.stdout.columns ?? 80;
    if (cols < SIDEBAR_MIN_COLS || navTargets().length === 0) return false;
    const mode = panelModeRef.current;
    if (mode === "off") return false;
    if (mode === "on") return true;
    return hasFleetActivity(agentRegistry.snapshot(), taskRegistry.snapshot());
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
    // Recalled prompts go back into the bar as plain text for editing — any
    // resolved paste data (expanded text, image attachments) is dropped here.
    // Re-editing a combined multi-prompt recall is already a fresh compose;
    // pasting again (or leaving the compact token as inert text) is the
    // simplest correct behaviour, and never crashes either way.
    const text = q.map((p) => p.text).join("\n");
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
    const armed =
      prev !== null && prev.id === cur.id && now - prev.at <= CTRL_X_WINDOW_MS;
    if (!armed) {
      lastCtrlXRef.current = { id: cur.id, at: now };
      return;
    }
    lastCtrlXRef.current = null;
    const idx = navTargets().findIndex(
      (t) => t.zone === cur.zone && t.id === cur.id,
    );
    if (cur.zone === "agent") agentRegistry.remove(cur.id);
    else taskRegistry.remove(cur.id);
    // Tear down any view tied to the deleted row.
    if (focusedAgentIdRef.current === cur.id) setFocusedAgentId(null);
    if (editingTaskIdRef.current === cur.id) {
      setEditingTaskId(null);
      injectText("");
    }
    const after = navTargets();
    const fallback =
      after.length === 0 ? null : after[Math.min(idx, after.length - 1)];
    if (fallback) setFocus(fallback);
    else setInputFocus();
  }, [
    navTargets,
    setFocus,
    setInputFocus,
    setFocusedAgentId,
    setEditingTaskId,
    injectText,
  ]);

  useInput((input, key) => {
    // Ctrl-C is handled first so it works even while a permission prompt is up
    // (cancelTurn releases the prompt as a denial before aborting). A live
    // `!command` takes priority: Ctrl-C kills it (like a real shell) rather than
    // cancelling the agent turn or quitting.
    if (key.ctrl && input === "c") {
      // A single idle Ctrl-C must NEVER exit (it would destroy typed-but-unsent
      // input); exit requires a double-press within CTRL_C_EXIT_WINDOW_MS. A
      // live `!command` child is killed first (like a real shell), then a
      // streaming turn is cancelled, then — if idle — text in the bar is cleared
      // before arming exit. See resolveCtrlC for the full priority order.
      const now = Date.now();
      const action = resolveCtrlC(
        {
          terminalRunning: terminalRunRef.current?.status === "running",
          streaming: streamingRef.current && abortRef.current !== null,
          inputEmpty: inputEmptyRef.current,
          lastCtrlCMs: lastCtrlCRef.current,
        },
        now,
      );
      switch (action) {
        case "kill-terminal":
          terminalHandleRef.current?.kill();
          lastCtrlCRef.current = null;
          clearCtrlCHint();
          break;
        case "cancel-turn":
          cancelTurn();
          lastCtrlCRef.current = null;
          clearCtrlCHint();
          break;
        case "clear-input":
          injectText("");
          lastCtrlCRef.current = null;
          clearCtrlCHint();
          break;
        case "arm-exit":
          lastCtrlCRef.current = now;
          armCtrlCHint();
          break;
        case "exit":
          lastCtrlCRef.current = null;
          clearCtrlCHint();
          void memoryRef.current?.close();
          exit();
          break;
      }
      return;
    }
    // While a permission prompt is up, ApprovalPrompt owns Esc and the answer keys.
    if (approvalRef.current) return;
    // Same for a budget-pause confirmation (see budgetPause above).
    if (budgetPauseRef.current) return;
    // Same for the pre-execution scope-review gate (its ScopeReview overlay owns
    // Run / Edit / Cancel via its own useInput).
    if (scopeReviewRef.current) return;
    // While the /config panel is open it owns the keyboard (its own useInput
    // handles ↑/↓/e/x/Esc) — swallow everything here so those keys never
    // double-fire into panel-nav, transcript scroll, or the prompt bar.
    if (configOpenRef.current) return;
    // Same for the /diff panel (its own useInput handles navigation/scroll/Esc).
    if (diffOpenRef.current) return;
    // Same for the /files panel (its own useInput handles nav/Ctrl-O/Esc —
    // including the double-Ctrl-O editor gesture, which must not fall through
    // to the global verbose toggle below).
    if (filesOpenRef.current) return;
    // Same for the /login panel (its own useInput handles Esc/any-key).
    if (loginOpenRef.current) return;

    // Ctrl-T / Ctrl-S toggle the task-inspector / swarm panels. Bound BEFORE
    // their own yield checks below so a second press closes the open panel
    // (each toggle also closes its siblings — one takeover panel at a time).
    if (key.ctrl && input === "t") {
      toggleTasksPanel();
      return;
    }
    if (key.ctrl && input === "s") {
      toggleSwarmPanel();
      return;
    }
    // The Ctrl+T/Ctrl+S/marketplace/prompts/create panels own the keyboard
    // while open — same yield rule as /config and /files above.
    if (tasksOpenRef.current) return;
    if (swarmOpenRef.current) return;
    if (marketplaceOpenRef.current) return;
    if (promptsOpenRef.current) return;
    if (createKindRef.current !== null) return;

    // Ctrl-O is the global "reveal detail" gesture (Claude Code style): it
    // flips verbose/expanded mode — long prompts, the enhanced-prompt scope
    // card, and reasoning render in FULL instead of a truncated preview — AND
    // expands/collapses the most recent folded `!command` accordion, so one key
    // reveals everything on screen. Bound before the focus-zone gate so it works
    // whether focus is on the input or a dock row.
    if (key.ctrl && input === "o") {
      setDetailExpanded((v) => !v);
      toggleLatestTerminal();
      return;
    }

    // ── Full-screen transcript scroll (fullscreen only) ──
    // PageUp/PageDown and Ctrl-U/Ctrl-D are never ambiguous with anything else
    // this REPL binds, so they scroll regardless of focus zone or buffer
    // content — bound here, before the focus-zone gate, for the same reason
    // Ctrl-O is above. Up/Down/Home/End are handled further below, gated on
    // the prompt bar being both focused AND empty (see inputEmptyRef) so they
    // never steal a keystroke from queue-recall, panel-entry, or cursor
    // movement while the bar has text.
    if (fullscreen) {
      if (key.pageUp) {
        dispatchScroll({ type: "page-up" });
        return;
      }
      if (key.pageDown) {
        dispatchScroll({ type: "page-down" });
        return;
      }
      if (key.ctrl && input === "u") {
        dispatchScroll({ type: "half-up" });
        return;
      }
      if (key.ctrl && input === "d") {
        dispatchScroll({ type: "half-down" });
        return;
      }
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

    // ── Global kill gesture (input zone): Ctrl-X twice ──
    // Kills the NEWEST running agent via the registry's abort seam — the
    // no-look version of the swarm panel's per-row kill (dock rows keep their
    // own Ctrl-X delete above; this only fires while the bar has focus).
    if (key.ctrl && input === "x") {
      const nowMs = Date.now();
      const running = agentRegistry
        .snapshot()
        .filter((a) => a.status === "running");
      const target = running[running.length - 1];
      if (!target) {
        globalCtrlXRef.current = null;
        pushAssistant("No running agents to kill — Ctrl+S shows the swarm.");
        return;
      }
      const prev = globalCtrlXRef.current;
      if (
        prev !== null &&
        prev.id === target.id &&
        nowMs - prev.at <= CTRL_X_WINDOW_MS
      ) {
        globalCtrlXRef.current = null;
        const aborted = agentRegistry.kill(target.id);
        pushAssistant(
          aborted
            ? `◼ Killed ${target.title}.`
            : `◼ Marked ${target.title} killed — it exposed no abort handle, so in-flight work may still settle (Esc cancels the whole turn).`,
        );
      } else {
        globalCtrlXRef.current = { id: target.id, at: nowMs };
        pushAssistant(`Press Ctrl+X again to kill ${target.title}.`);
      }
      return;
    }

    // History scrolling is native terminal scrollback in the classic INLINE
    // mode (off a TTY, or the fallback for tests/pipes): finished messages
    // commit via <Static> into the real screen buffer, so PageUp/PageDown/
    // mouse-wheel reach the terminal exactly like they would for `less` or
    // any other normal-buffer program — the REPL does not bind them there. In
    // FULL-SCREEN mode the alternate screen buffer has no scrollback of its
    // own, so the transcript viewport owns scrolling instead (Page/Ctrl-U/
    // Ctrl-D above; Up/Down/Home/End below, while the bar is empty).

    // ── Prompt-bar arrows (focus is on the input) ──
    // Only when the slash menu is CLOSED — while it's open the arrows navigate
    // suggestions inside PromptInput. Up recalls the queued prompts for editing;
    // Down moves focus into the Agent Team / Task Progress dock. In full-screen
    // mode, when the bar is EMPTY, Up/Down/Home/End scroll the transcript
    // instead — the instant there's text in the bar they fall back to the
    // behavior below, unchanged.
    if (!menuOpenRef.current) {
      if (fullscreen && inputEmptyRef.current) {
        // Up/Down on an empty bar KEEP their must-preserve meanings first —
        // Up recalls the queued prompts for editing, Down enters the Agent
        // Team / Task Progress dock — and fall through to transcript
        // line-scroll ONLY when there is nothing to recall / no panel to
        // enter. Home/End, PageUp/PageDown, Ctrl-U/Ctrl-D and the mouse wheel
        // always scroll regardless. This restores panel navigation, which an
        // unconditional line-scroll binding here would have broken.
        if (key.upArrow) {
          if (queueRef.current.length > 0) recallQueue();
          else dispatchScroll({ type: "line-up" });
          return;
        }
        if (key.downArrow) {
          if (panelReachable() && navTargets()[0]) enterPanel();
          else dispatchScroll({ type: "line-down" });
          return;
        }
        if (key.home) {
          dispatchScroll({ type: "home" });
          return;
        }
        if (key.end) {
          dispatchScroll({ type: "end" });
          return;
        }
      }
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
      const order: PermissionMode[] = [
        "ask",
        "acceptEdits",
        "bypass",
        "readonly",
      ];
      const idx = order.indexOf(modeRef.current);
      const next = order[(idx + 1) % order.length]!;
      setMode(next);
      brokerRef.current?.setMode(next);
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

  // ── Background dispatch (docs/specs/repl-async-dispatch.md §3.4) ────────────
  // Spawn a detached worker for `prompt` and register it with the tracker so its
  // progress + completion fold back into the transcript. `reserved` says a
  // concurrency slot was already claimed for this dispatch (so a spawn failure
  // must release it). Returns after the <50 ms spawn — the composer is free.
  const dispatchOne = useCallback(
    async (prompt: string, reserved: boolean): Promise<void> => {
      try {
        const { dispatchDetachedSession } = await import(
          "../sessions/dispatch.js"
        );
        const { sid, title } = await dispatchDetachedSession({ cwd, prompt });
        trackerRef.current?.add(sid, title);
        pushAssistant(
          `◇ dispatched ${shortSid(sid)} · "${title}" — running in the background; ` +
            `\`oxagen fleet send ${shortSid(sid)} "…"\` to follow up.`,
        );
      } catch (err) {
        if (reserved) trackerRef.current?.release();
        pushAssistant(
          `Fleet dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [cwd, pushAssistant],
  );

  // Route a prompt to the background, honoring the concurrency cap: claim a slot
  // if one is free, otherwise queue locally (never spawn unbounded workers).
  const dispatchToBackground = useCallback(
    (prompt: string): void => {
      const tracker = trackerRef.current;
      // The RESOURCE-EFFECTIVE cap: the configured /dispatch cap, scaled down
      // under memory/CPU pressure (resource-monitor.ts). Checked before the
      // tracker's own fixed-cap reserve so a strained machine queues instead
      // of piling on more detached workers.
      const effectiveCap =
        resourceMonitorRef.current?.effectiveConcurrency(
          dispatchCapRef.current,
        ) ?? dispatchCapRef.current;
      if (
        tracker &&
        (tracker.runningCount() >= effectiveCap || !tracker.reserve())
      ) {
        dispatchQueueRef.current = [...dispatchQueueRef.current, prompt];
        pushAssistant(
          `⧗ dispatch queued (${tracker.runningCount()} running, effective cap ${Math.min(effectiveCap, tracker.maxConcurrent())}) — ` +
            `starts when a background slot frees.`,
        );
        return;
      }
      void dispatchOne(prompt, tracker !== null);
    },
    [dispatchOne, pushAssistant],
  );

  // Drain the local dispatch queue as slots free (called by the tracker on every
  // completion). Reserves atomically per prompt so the cap is never exceeded —
  // and re-checks the resource-effective cap per iteration so a strained
  // machine stops refilling even when fixed-cap slots are free.
  const drainDispatchQueue = useCallback((): void => {
    const tracker = trackerRef.current;
    if (!tracker) return;
    while (dispatchQueueRef.current.length > 0) {
      const effectiveCap =
        resourceMonitorRef.current?.effectiveConcurrency(
          dispatchCapRef.current,
        ) ?? dispatchCapRef.current;
      if (tracker.runningCount() >= effectiveCap || !tracker.reserve()) break;
      const next = dispatchQueueRef.current[0] as string;
      dispatchQueueRef.current = dispatchQueueRef.current.slice(1);
      void dispatchOne(next, true);
    }
  }, [dispatchOne]);
  drainRef.current = drainDispatchQueue;

  const handleSubmit = useCallback(
    async (text: string, paste?: PasteSubmission) => {
      // `!cmd` is intercepted synchronously in handleUserSubmit (it runs
      // immediately, bypassing this queue, so it works mid-turn) — it never
      // reaches the pump. Guard here too so a `!` that somehow slips through the
      // queue path is still handled rather than sent to the model as a prompt.
      if (text.startsWith("!")) {
        runShellCommand(text);
        return;
      }

      // ── Background dispatch routing (docs/specs/repl-async-dispatch.md) ──
      // A trailing ` &` (either mode) or a "task"-classified prompt while
      // Dispatch mode is ON goes to a detached worker; the composer frees
      // immediately (dispatch is <50 ms). Slash/shell commands and forced-inline
      // `=`/`>` prompts never dispatch — they fall through to the inline path.
      // `decideDispatch` returns the prompt with the routing markers stripped.
      {
        const decision = decideDispatch(text, {
          mode: dispatchModeRef.current,
        });
        // Plan-only mode forces INLINE routing: a background dispatch would
        // execute the prompt in a detached worker, silently bypassing the
        // plan-only gate below — the one thing /plan promises can't happen.
        if (decision.kind === "background" && !planOnlyRef.current) {
          dispatchToBackground(decision.prompt);
          return;
        }
        // Inline: run today's turn on the marker-stripped prompt (a forced-inline
        // `=`/`>` prefix is removed; every other case is unchanged).
        text = decision.prompt;
      }

      // ── Slash commands ──
      // Match on the leading whitespace-delimited token, never a prefix or a
      // bare `===`. `text === "/help"` used to reject `/help x` (fell through to
      // "unknown command"), and `text.startsWith("/model")` used to swallow
      // `/models`, `/modelx`, etc. Extracting the command token fixes both:
      // argless commands tolerate-and-ignore trailing args, and arg commands can
      // never collide with a longer-named sibling. Handler bodies still read
      // their args via `text.slice("/name".length)`, which stays correct because
      // an exact token match guarantees `text` is `"/name"` or `"/name …args"`.
      const cmd = text.split(/\s+/)[0];
      if (cmd === "/help") {
        pushAssistant(HELP);
        return;
      }
      if (cmd === "/init") {
        pushAssistant("Initializing…");
        try {
          const { runInit, formatInitSummary } = await import(
            "../commands/init.js"
          );
          const result = await runInit({ cwd });
          pushAssistant(formatInitSummary(result));
        } catch (err) {
          pushAssistant(
            `Init failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        return;
      }
      if (cmd === "/clear") {
        resetConversation();
        return;
      }
      if (cmd === "/hud") {
        // Toggle the heads-up display of every agent running this session.
        const next = !hudVisibleRef.current;
        hudVisibleRef.current = next;
        setHudVisible(next);
        return;
      }
      if (cmd === "/dispatch") {
        // Dispatch mode: `on` | `off` | (bare toggles) | `cap <n>` | `status`.
        // Persisted in the local settings tier so it survives restarts.
        const arg = text.slice("/dispatch".length).trim().toLowerCase();
        const applyMode = (next: boolean): void => {
          setDispatchMode(next);
          dispatchModeRef.current = next;
          try {
            persistDispatchMode(next, cwd);
          } catch {
            // A settings-write failure must not break the toggle for THIS
            // session — the ref/state already changed; it just won't persist.
          }
          pushAssistant(
            next
              ? `⇉ Dispatch mode ON — task prompts run in the background (cap ${dispatchCapRef.current}); ` +
                  `lookups still answer inline. Prefix a prompt with \`=\` to force it inline, ` +
                  `or suffix \` &\` to force background. \`/dispatch off\` to stop.`
              : "⇉ Dispatch mode OFF — prompts run inline again (` &` still backgrounds explicitly).",
          );
        };
        if (arg === "") {
          applyMode(!dispatchModeRef.current);
          return;
        }
        if (arg === "on") {
          applyMode(true);
          return;
        }
        if (arg === "off") {
          applyMode(false);
          return;
        }
        if (arg === "status") {
          pushAssistant(
            `⇉ Dispatch mode ${dispatchModeRef.current ? "ON" : "OFF"} · ` +
              `cap ${dispatchCapRef.current} · ${trackerRef.current?.runningCount() ?? 0} running · ` +
              `${dispatchQueueRef.current.length} queued.`,
          );
          return;
        }
        if (arg.startsWith("cap")) {
          const n = Number.parseInt(arg.slice("cap".length).trim(), 10);
          if (!Number.isFinite(n) || n < 1) {
            pushAssistant(
              "Usage: /dispatch cap <n> — max concurrent background dispatches (≥ 1).",
            );
            return;
          }
          dispatchCapRef.current = n;
          trackerRef.current?.setMaxConcurrent(n);
          try {
            persistDispatchCap(n, cwd);
          } catch {
            // Non-fatal — the live cap already changed.
          }
          pushAssistant(`⇉ Dispatch concurrency cap set to ${n}.`);
          return;
        }
        pushAssistant(
          "Usage: /dispatch [on|off] — toggle async dispatch mode · " +
            "/dispatch cap <n> — set the concurrency cap · /dispatch status.",
        );
        return;
      }
      if (cmd === "/config") {
        const arg = text.slice("/config".length).trim().toLowerCase();
        if (arg === "doctor") {
          try {
            const { runConfigDoctor, formatDoctorReport } = await import(
              "../config/doctor.js"
            );
            pushAssistant(formatDoctorReport(runConfigDoctor(cwd)));
          } catch (err) {
            pushAssistant(
              `Config doctor failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          return;
        }
        if (arg) {
          pushAssistant(
            "Usage: /config — browse and edit the tiered config (repo ▸ workspace ▸ user ▸ org managed); " +
              "/config doctor — scan the tiers for problems and customization recommendations.",
          );
          return;
        }
        configOpenRef.current = true;
        setConfigOpen(true);
        return;
      }
      if (cmd === "/diff") {
        // `/diff` opens the changed-file list; `/diff <path>` opens straight
        // into that file's diff (suffix-matched inside the panel).
        const arg = text.slice("/diff".length).trim();
        setDiffInitialPath(arg || undefined);
        diffOpenRef.current = true;
        setDiffOpen(true);
        return;
      }
      if (cmd === "/files") {
        // Files Touched — every file the agent read/created/updated/deleted
        // this session, with live +/- counts and editor/diff shortcuts.
        filesOpenRef.current = true;
        setFilesOpen(true);
        return;
      }
      if (cmd === "/panel") {
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
      if (cmd === "/mouse") {
        const next = !mouseOnRef.current;
        mouseOnRef.current = next;
        setMouseOn(next);
        pushAssistant(
          next
            ? "Mouse-wheel scroll ON — the transcript viewport now responds to wheel/trackpad scroll. Heads up: while it's on, your terminal's native text selection is disabled and a copied selection can pick up stray escape codes. Use keyboard scroll instead if you want to select/copy text. /mouse to turn it back off."
            : "Mouse-wheel scroll OFF (the default). Native text selection + copy now work — just drag and Cmd/Ctrl-C. Scroll with the keyboard: PageUp/PageDown (page), Ctrl-U/Ctrl-D (half-page), Up/Down (line) and Home/End (top/bottom) on an empty bar. /mouse to turn wheel scroll back on.",
        );
        return;
      }
      if (cmd === "/motion") {
        const raw = text.slice("/motion".length).trim().toLowerCase();
        // "on" reads naturally as "turn animations on" — accept it as full.
        const arg = raw === "on" ? "full" : raw;
        if (!arg) {
          pushAssistant(
            `Motion: ${motionRef.current}.\n` +
              "Use /motion full|reduced|off — full animates everything; reduced " +
              "drops the space-invaders duel and the prompt bar's border flash; " +
              "off disables all animation, including the thinking indicator.",
          );
          return;
        }
        if (arg !== "full" && arg !== "reduced" && arg !== "off") {
          pushAssistant(
            `Unknown motion mode "${raw}" — use /motion full|reduced|off.`,
          );
          return;
        }
        motionRef.current = arg;
        setMotion(arg);
        setMotionMode(arg); // persist across sessions
        pushAssistant(
          arg === "full"
            ? "Motion FULL — all animations on (saved)."
            : arg === "reduced"
              ? "Motion REDUCED — space-invaders duel and prompt border flash off; thinking indicator stays (saved)."
              : "Motion OFF — all animations off, including the thinking indicator (saved).",
        );
        return;
      }
      // Shared applier for the per-function model commands: update session
      // state, persist to the LOCAL settings scope (durable across sessions),
      // refresh the MODELS readout to what will now run, and confirm. Any
      // gateway/Vercel-SDK text model slug is accepted — no allowlist; a bad
      // slug surfaces as a clear 4xx on the next turn.
      const applyRoleModel = (role: ModelRole, slug: string): void => {
        if (role === "worker") setModel(slug);
        else if (role === "judge") setJudgeModel(slug);
        else setTriageModel(slug);
        let saved = false;
        try {
          persistRoleModel(role, slug);
          saved = true;
        } catch {
          // Persistence is best-effort — the in-session change still applies.
        }
        // Compute the readout with the just-changed role plus the current others.
        const worker = role === "worker" ? slug : (modelRef.current ?? "auto");
        const triage = role === "triage" ? slug : triageModelRef.current;
        const judge = role === "judge" ? slug : judgeModelRef.current;
        dispatchTelemetry({
          type: "seed-models",
          models: resolveModelRoles(worker, { triage, judge }),
        });
        pushAssistant(
          `${role[0]!.toUpperCase()}${role.slice(1)} model set to ${slug}` +
            (saved ? " (saved to .oxagen/settings.local.json)." : "."),
        );
      };
      // Shared by /worker-model and /model: "auto" unpins (per-turn routing),
      // a slug pins, bare prints the current state.
      const workerModelReadout = (): string =>
        modelRef.current ??
        `auto — routed per turn: cheapest sufficient tier, ` +
          `${resolveModelId()} default, precise tier for auth/billing/security/migrations. ` +
          `Pin with /worker-model <slug>.`;
      const handleWorkerModelCommand = (slug: string): void => {
        if (!slug) {
          pushAssistant(`Current worker model: ${workerModelReadout()}`);
          return;
        }
        if (slug === "auto" || slug === "default") {
          setModel(null);
          dispatchTelemetry({
            type: "seed-models",
            models: resolveModelRoles("auto", {
              triage: triageModelRef.current,
              judge: judgeModelRef.current,
            }),
          });
          pushAssistant(
            "Worker model set to auto — each turn routes to the cheapest sufficient tier " +
              "(precise tier for high-stakes work). Session-only: a persisted pin " +
              "(settings workerModel, OXAGEN_MODEL, or `oxagen config model`) re-applies on restart.",
          );
          return;
        }
        applyRoleModel("worker", slug);
      };
      if (cmd === "/worker-model") {
        handleWorkerModelCommand(text.slice("/worker-model".length).trim());
        return;
      }
      if (cmd === "/judge-model") {
        const slug = text.slice("/judge-model".length).trim();
        if (slug) applyRoleModel("judge", slug);
        else
          pushAssistant(
            `Current judge model: ${judgeModelRef.current ?? "(engine default — advisor tier, distinct from worker)"}`,
          );
        return;
      }
      if (cmd === "/triage-model") {
        const slug = text.slice("/triage-model".length).trim();
        if (slug) applyRoleModel("triage", slug);
        else
          pushAssistant(
            `Current triage model: ${triageModelRef.current ?? "(engine default — local heuristic / OXAGEN_LLM_EVALUATOR)"}`,
          );
        return;
      }
      if (cmd === "/model") {
        // Alias for /worker-model — sets and persists the executor model.
        handleWorkerModelCommand(text.slice("/model".length).trim());
        return;
      }
      if (cmd === "/coordinator") {
        const arg = text.slice("/coordinator".length).trim().toLowerCase();

        if (!arg) {
          const where =
            coordinatorLocRef.current === "local"
              ? `local on-device (${localCoordinatorRef.current?.modelId ?? "not yet loaded"})`
              : "remote platform gateway";
          const persisted =
            getCoordinator() === "on-device" ? "local" : "remote";
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
              `(${modelRef.current ?? "auto-routed"}). /coordinator local to run fully on-device.`,
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
            // Resolve through the runtime provider factory — the ONE live seam
            // for coordinator transport selection (a future Ollama/ONNX provider
            // drops in behind resolveCoordinatorAi with no change here).
            const coord = await resolveCoordinatorAi({
              baseAi: aiRef.current,
              coordinatorId: "on-device",
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

        pushAssistant(
          `Unknown coordinator "${arg}". Use /coordinator remote|local.`,
        );
        return;
      }
      if (cmd === "/effort") {
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
      if (cmd === "/budget") {
        const parsed = parseBudgetCommand(text.slice("/budget".length));
        switch (parsed.kind) {
          case "status": {
            const p = budgetRef.current;
            if (!p.enabled) {
              pushAssistant(
                "Per-turn budget: off (turns run unbounded).\n" +
                  "Use /budget <usd> [grace|prompt|enforce] to enable, e.g. /budget 2.50 prompt.\n" +
                  describeBudgetModes(),
              );
            } else {
              const meta = TURN_BUDGET_MODES[p.mode];
              pushAssistant(
                `Per-turn budget: ${formatBudgetUsd(p.limitUsd)} — ${meta.label} (${p.mode}). ` +
                  `${meta.description}\n` +
                  "Use /budget off to disable, /budget mode <mode> to change the mode, " +
                  "or /budget <usd> to change the limit.",
              );
            }
            break;
          }
          case "off": {
            setBudgetPolicy(TURN_BUDGET_OFF);
            pushAssistant("Per-turn budget disabled — turns run unbounded.");
            break;
          }
          case "mode": {
            const next: TurnBudgetPolicy = {
              ...budgetRef.current,
              mode: parsed.mode,
            };
            setBudgetPolicy(next);
            const meta = TURN_BUDGET_MODES[parsed.mode];
            pushAssistant(
              `Budget mode set to ${meta.label} (${parsed.mode}). ${meta.description}` +
                (next.enabled
                  ? ""
                  : " (Budget is currently off — set a limit with /budget <usd> to enable it.)"),
            );
            break;
          }
          case "set": {
            setBudgetPolicy(parsed.policy);
            const meta = TURN_BUDGET_MODES[parsed.policy.mode];
            pushAssistant(
              `Per-turn budget set to ${formatBudgetUsd(parsed.policy.limitUsd)} — ` +
                `${meta.label} (${parsed.policy.mode}). ${meta.description}`,
            );
            break;
          }
          case "invalid": {
            pushAssistant(
              `Couldn't parse "/budget ${parsed.raw}". Use:\n` +
                "  /budget                 show current policy\n" +
                "  /budget off             disable\n" +
                "  /budget <usd> [mode]    enable, e.g. /budget 2.50 prompt\n" +
                "  /budget mode <mode>     change mode only\n" +
                describeBudgetModes(),
            );
            break;
          }
        }
        return;
      }
      if (cmd === "/mode") {
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
          pushAssistant(
            `Unknown mode "${arg}". Use ask, auto-edit, bypass, or readonly.`,
          );
        }
        return;
      }
      if (cmd === "/replay") {
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
      if (cmd === "/traces") {
        const traces = traceStoreRef.current.list();
        pushAssistant(
          traces.length === 0
            ? "No turns recorded yet."
            : "Recent turns (use /replay <n>):\n" +
                traces
                  .slice(0, 10)
                  .map((t, i) => summarizeTrace(t, i))
                  .join("\n"),
        );
        return;
      }
      if (cmd === "/pipeline") {
        const arg = text.slice("/pipeline".length).trim().toLowerCase();
        if (arg === "off") {
          bareRef.current = true;
          setPipelineOn(false);
          pushAssistant(
            "Pipeline OFF — running the bare agent (no eval/enhance/judge).",
          );
        } else if (arg === "on") {
          bareRef.current = false;
          setPipelineOn(true);
          pushAssistant(
            "Pipeline ON — prompts are evaluated, enhanced, and judged for completeness.",
          );
        } else {
          pushAssistant(
            `Pipeline is ${bareRef.current ? "OFF" : "ON"}. Use /pipeline on|off.`,
          );
        }
        return;
      }
      if (cmd === "/verbose") {
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
          pushAssistant(
            `Verbose is ${verboseRef.current ? "ON" : "OFF"}. Use /verbose on|off.`,
          );
        }
        return;
      }
      if (cmd === "/debug") {
        // Toggle the JSONL debug file log for THIS process. isDebugEnabled()
        // reads process.env on every call, so flipping the env var here takes
        // effect immediately for every subsequent debugLog() in this session —
        // no restart, no settings write (use settings.json `env` to persist).
        const arg = text.slice("/debug".length).trim().toLowerCase();
        const report = (): void => {
          pushAssistant(
            `🐞 Debug file log ${isDebugEnabled() ? "ON" : "OFF"} — ${debugLogFile()}\n` +
              `Streams invoke/turn/pipeline/llm/timeout/error records as JSONL. ` +
              `Tail it with: oxagen logs --follow (or jq the file directly).`,
          );
        };
        if (arg === "status") {
          report();
          return;
        }
        const next =
          arg === "on" ? true : arg === "off" ? false : !isDebugEnabled();
        if (arg !== "" && arg !== "on" && arg !== "off") {
          pushAssistant("Usage: /debug [on|off|status]");
          return;
        }
        if (next) {
          process.env[DEBUG_ENV] = "1";
          // First entry doubles as the enable marker (and proves the sink works).
          void debugLog("invoke", "debug.enabled", { via: "/debug" });
        } else {
          void debugLog("invoke", "debug.disabled", { via: "/debug" });
          process.env[DEBUG_ENV] = "0";
        }
        report();
        return;
      }
      if (cmd === "/plan") {
        // Plan-only mode: see the planOnlyRef block up top. `/plan run`
        // re-submits the last planned prompt with a one-shot bypass token.
        const arg = text.slice("/plan".length).trim().toLowerCase();
        const applyPlanMode = (next: boolean): void => {
          planOnlyRef.current = next;
          setPlanOnly(next);
          pushAssistant(
            next
              ? "▤ Plan-only mode ON — prompts are decomposed into a task plan (inspect it with Ctrl+T " +
                  "or /panel) and NOTHING executes. `/plan run` executes the last plan; `/plan off` resumes normal turns."
              : "▤ Plan-only mode OFF — prompts execute normally again.",
          );
        };
        if (arg === "") {
          applyPlanMode(!planOnlyRef.current);
          return;
        }
        if (arg === "on") {
          applyPlanMode(true);
          return;
        }
        if (arg === "off") {
          applyPlanMode(false);
          return;
        }
        if (arg === "status") {
          pushAssistant(
            `▤ Plan-only mode ${planOnlyRef.current ? "ON" : "OFF"}` +
              (lastPlanOnlyRef.current
                ? ` · last planned prompt: "${lastPlanOnlyRef.current.slice(0, 80)}${lastPlanOnlyRef.current.length > 80 ? "…" : ""}"`
                : " · no prompt planned yet"),
          );
          return;
        }
        if (arg === "run") {
          const last = lastPlanOnlyRef.current;
          if (!last) {
            pushAssistant(
              "No plan to run — submit a prompt while plan-only mode is ON first.",
            );
            return;
          }
          planRunOverrideRef.current = last;
          pushAssistant("▶ Executing the last planned prompt…");
          resubmitRef.current(last);
          return;
        }
        pushAssistant("Usage: /plan [on|off|status|run]");
        return;
      }
      if (cmd === "/tasks") {
        toggleTasksPanel();
        return;
      }
      if (cmd === "/swarm") {
        toggleSwarmPanel();
        return;
      }
      if (cmd === "/marketplace") {
        openMarketplacePanel();
        return;
      }
      if (cmd === "/prompts") {
        openPromptsPanel();
        return;
      }
      if (
        cmd === "/create-command" ||
        cmd === "/create-agent" ||
        cmd === "/create-skill" ||
        cmd === "/create-prompt"
      ) {
        openCreateWizard(cmd.slice("/create-".length) as CreateKind);
        return;
      }
      if (cmd === "/login") {
        // Already logged in: just report the session (fast path, no need to
        // open the picker at all). Not logged in: open the Ink-native
        // LoginPanel below — it drives the same browser-based PKCE flow
        // `oxagen login` uses, with NO readline (see login-panel.tsx's
        // header for why that matters inside an Ink-mounted REPL).
        try {
          const { getToken, readConfig } = await import("../lib/config.js");
          const token = getToken();
          const config = readConfig();
          if (token && config.orgSlug && config.workspaceSlug) {
            const masked =
              token.length <= 8
                ? "****"
                : token.slice(0, 4) + "…" + token.slice(-4);
            pushAssistant(
              `Logged in to Oxagen:\n` +
                `  token:     ${masked}\n` +
                `  org:       ${config.orgSlug}\n` +
                `  workspace: ${config.workspaceSlug}\n` +
                `\nRun \`oxagen logout\` (or /logout) to clear the session.`,
            );
          } else {
            loginOpenRef.current = true;
            setLoginOpen(true);
          }
        } catch (err) {
          pushAssistant(err instanceof Error ? err.message : String(err));
        }
        return;
      }
      if (cmd === "/logout") {
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
      if (cmd === "/remember") {
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
          pushAssistant(
            formatRememberResult(await rememberMemory({ text: body })),
          );
        } catch (err) {
          pushAssistant(err instanceof Error ? err.message : String(err));
        }
        return;
      }
      if (cmd === "/memories") {
        const arg = text.slice("/memories".length).trim();
        try {
          const { listMemories, formatMemoryLines, MEMORY_CLASSES } =
            await import("../lib/memory-client.js");
          // The argument may be an epistemic class (OBSERVATION/RULE/FACT) or a
          // free-text content-domain kind — memoryKind is an open string, so
          // anything else is passed through verbatim as a kind filter.
          let memoryClass: (typeof MEMORY_CLASSES)[number] | undefined;
          let memoryKind: string | undefined;
          if (arg) {
            const upper = arg.toUpperCase();
            if (
              MEMORY_CLASSES.includes(upper as (typeof MEMORY_CLASSES)[number])
            ) {
              memoryClass = upper as (typeof MEMORY_CLASSES)[number];
            } else {
              memoryKind = arg;
            }
          }
          pushAssistant(
            formatMemoryLines(
              await listMemories({ memoryClass, memoryKind, limit: 30 }),
            ),
          );
        } catch (err) {
          pushAssistant(err instanceof Error ? err.message : String(err));
        }
        return;
      }
      if (cmd === "/forget") {
        const id = text.slice("/forget".length).trim();
        if (!id) {
          pushAssistant(
            "Usage: /forget <id> — permanently deletes a memory by id (see /memories).",
          );
          return;
        }
        try {
          const { deleteMemory } = await import("../lib/memory-client.js");
          const { deleted } = await deleteMemory(id);
          pushAssistant(
            deleted
              ? `✓ Forgot memory ${id}.`
              : `No memory ${id} found in this workspace.`,
          );
        } catch (err) {
          pushAssistant(err instanceof Error ? err.message : String(err));
        }
        return;
      }
      if (cmd === "/exit" || cmd === "/quit") {
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
          // Not a built-in and not a custom .md command. The catalog's "cli"
          // tier (see slash/catalog.ts + repl/cli-bridge.ts) splits three ways:
          //   1. Safe/read-only commands run INLINE through the capture
          //      seam — their output becomes this turn's assistant message,
          //      instead of the old "run it from your shell" dead-end.
          //   2. Long-running/interactive commands (they own the terminal or
          //      run indefinitely) get an honest "opens outside the REPL"
          //      message — never silently dead-ended, never run inline.
          //   3. Everything else not yet ported to the seam keeps a shell-out
          //      hint (now worded as "not yet available inline", which is
          //      true — distinct from bucket 2's "this genuinely can't run
          //      here").
          const invocation = parseInvocation(text);
          const name = invocation?.name ?? text.split(/\s+/)[0]!.slice(1);
          const entry = catalogRef.current?.find((c) => c.name === name);
          if (entry && entry.source === "cli") {
            const shellCmd = toShellCommand(entry.name);
            if (isExternalOnlyCliCommand(entry.name)) {
              pushAssistant(
                `⧉ oxagen ${shellCmd} opens outside the REPL — run it from a separate shell: ` +
                  `oxagen ${shellCmd}`,
              );
            } else if (isInlineDispatchableCliCommand(entry.name)) {
              const result = await runInlineCliCommand(
                entry.name,
                invocation?.args ?? "",
                options.buildProgram,
              );
              pushAssistant(
                `📦 oxagen ${shellCmd}\n\n${result.ok ? result.output : `✗ ${result.output}`}`,
              );
            } else {
              const hint = entry.argumentHint ? ` ${entry.argumentHint}` : "";
              pushAssistant(
                `📦 oxagen ${shellCmd}${hint} — ${entry.description}\n` +
                  `Not yet available inline in the REPL — run it from your shell: oxagen ${shellCmd}`,
              );
            }
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
      dispatchTelemetry({ type: "turn-start", at: Date.now() });
      lastProgressRef.current = Date.now();
      const controller = new AbortController();
      abortRef.current = controller;

      // Bound the turn by PROGRESS, not by a wall clock (Bug 1). The controller
      // fires only on user Esc/Ctrl-C — there is NO per-turn time cap, so a long
      // but healthy turn (hundreds of model calls, a worker→judge loop) runs to
      // completion. The inactivity guard aborts ONLY when no progress — a stream
      // delta, a stage, a tool call, a completed model call — lands within
      // turnInactivityMs. An EXECUTING tool or fleet is progress even though it
      // emits nothing until it finishes (bash allows up to 600s; a fleet subagent
      // can work silently for minutes) — the guard defers while one is in flight.
      // And before aborting it makes one call-out: if this turn was watching CI
      // and checks are still pending, the wait is legitimate — extend, capped
      // cumulatively at resolveCiWaitCapMs() (2h default). Per-model-call
      // timeouts live in the metered AI port.
      const inactivityMs = resolveTurnInactivityMs();
      let inFlightTools = 0;
      let fleetInFlight = false;
      // Set by the plan-only gate below: the turn ended after planning, so the
      // finally must NOT finalize the checklist — the pending tasks ARE the output.
      let planOnlyExit = false;
      const ciProbe = createCiWaitProbe(cwd);
      // The REPL tracks tools/fleet in its own closures (the stream sinks below
      // mutate them), so the fleet-aware shouldDefer REPLACES the runner's
      // built-in in-flight-tool default — fold both signals in here.
      const runner = createTurnRunner(
        { turnInactivityMs: inactivityMs },
        {
          callerSignal: controller.signal,
          onLog: (line) => void debugLog("timeout", line),
          stall: {
            shouldDefer: () => inFlightTools > 0 || fleetInFlight,
            probe: () => ciProbe.probe(),
          },
        },
      );
      // Record progress: reset the inactivity guard AND advance the idle clock
      // (lastProgressRef also feeds the ThinkingIndicator heartbeat).
      const noteProgress = (): void => {
        runner.noteProgress();
        lastProgressRef.current = Date.now();
      };

      // This turn's streamed messages (tool annotations + assistant text).
      const turn: Message[] = [];
      let assistantOpen = false;
      let reasoningOpen = false;
      // Per-edit diff bookkeeping: which files already had their diff pushed
      // this turn (and the exact text shown), so the round's final-diff isn't
      // re-pushed when it would only repeat what's already on screen, and a
      // repeat edit landing identical content doesn't push a duplicate.
      const editDiffsShown = new Set<string>();
      const lastEditDiff = new Map<string, string>();
      // Every stream sink below (onReasoning, onText, onFileChange, etc.) calls
      // `render()` on every streamed token/delta — a fast model call can fire
      // this dozens of times a second. Route it through a throttle that
      // coalesces same-frame calls into ONE `commit()` (~30fps) instead of one
      // per token; the turn's own `finally` below does one final, untrottled
      // flush so the very last tokens always land immediately. The getter
      // closure re-reads `base`/`turn` fresh each time it's invoked (at
      // whatever moment the frame timer actually fires), never a snapshot
      // taken when `render()` was called — see render-throttle.ts.
      const renderThrottle = createRenderThrottle<Message[]>(commit, {
        frameMs: 33,
      });
      renderThrottleRef.current = renderThrottle;
      const render = (): void =>
        renderThrottle.schedule(() => [...base, ...turn]);
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

      // Fresh Task Progress checklist for this turn. The checklist is the REAL
      // plan — the per-turn planner's tasks, seeded below once it runs. Pipeline
      // stages are not tasks: they only advance the active task's live detail.
      taskRegistry.clear();
      /** The planned task the single-loop path is currently executing. */
      let activePlanTaskId: string | null = null;
      const recordStageTask = (kind: string, detail?: string): void => {
        if (kind === "complete") {
          taskRegistry.finalizeOpen("done");
          return;
        }
        if (activePlanTaskId) {
          taskRegistry.update(activePlanTaskId, {
            status: "in_progress",
            ...(detail !== undefined ? { detail } : {}),
          });
        }
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
            pushAssistant(
              "Project initialization skipped. Use .oxagen/settings.json to configure.",
            );
            return;
          }
          setApproval(null);
        }

        void debugLog("turn", "turn.start", {
          mode: "repl",
          readOnly: modeRef.current === "readonly",
          model: modelRef.current ?? "auto",
          prompt: submission,
        });
        // Surface this turn in the `/hud` heads-up display for its whole life.
        // The abort handle wires the swarm panel / global Ctrl-X kill gesture
        // to this turn's own controller — killing the lead turn IS cancelling
        // it (the catch below reports "(cancelled)").
        hudHandle = agentRegistry.register({
          kind: "turn",
          title: submission,
          model: modelRef.current ?? "auto",
          abort: controller,
        });

        // Resolve this turn's pasted image attachments (Ctrl-V) into bytes.
        // Each is read independently — a missing/unreadable temp file (deleted,
        // permissions) drops just that one image with a visible note in the
        // transcript, never fails the whole turn (degrade gracefully, never crash).
        const images: Array<{ data: Buffer; mediaType: string }> = [];
        for (const img of paste?.images ?? []) {
          try {
            images.push({
              data: await readFile(img.path),
              mediaType: img.mediaType,
            });
          } catch (err) {
            turn.push({
              role: "assistant",
              content: `⚠ Couldn't attach a pasted image (${err instanceof Error ? err.message : String(err)}) — continuing without it.`,
              timestamp: Date.now(),
            });
            render();
          }
        }

        // Headless enhance budget, mirrored here for the interactive REPL: on a
        // cold store the first code-graph query triggers a full tree-sitter build
        // (135s+ on a Django-sized repo) — without a bound the ENHANCE stage would
        // hang the turn on "thinking…" indefinitely (`enhanceTimeoutMs` is
        // `undefined` ⇒ unbounded in the pipeline). one-shot.ts applies this same
        // default for headless runs; a human staring at a spinner needs it just as
        // much. OXAGEN_ENHANCE_TIMEOUT_MS overrides (0 disables the bound).
        const enhanceTimeoutRaw = Number(
          process.env["OXAGEN_ENHANCE_TIMEOUT_MS"],
        );
        const enhanceTimeoutMs = Number.isFinite(enhanceTimeoutRaw)
          ? enhanceTimeoutRaw > 0
            ? enhanceTimeoutRaw
            : undefined
          : 15_000;

        // Combined memory for this turn — shared by the planner below and the
        // executing loop, so both recall the same lessons.
        const turnMemory = createCombinedMemory(
          memoryRef.current,
          fleetMemoryRef.current,
          {
            server: serverMemoryRef.current,
            recallQuery: submission,
          },
        );

        // ── Plan the turn ────────────────────────────────────────────────────
        // Every turn gets a REAL plan: one structured planner call decomposes
        // the submission (with a digest of the recent conversation) into
        // concrete tasks. Bare mode opted out of pipeline model calls, so it
        // gets the router-derived single-task plan instead — still genuine,
        // never an invented checklist.
        const goalText = paste?.expandedText ?? submission;
        const pushStage = (stage: StageEvent): void => {
          closeStreamingBlocks();
          lastActivityRef.current = stage.detail ?? stage.label;
          turn.push({
            role: "stage",
            stage,
            content: stage.label,
            timestamp: Date.now(),
          });
          dispatchTelemetry({ type: "stage", stage });
          render();
        };
        let plan;
        if (bareRef.current) {
          plan = fallbackPlan(goalText);
        } else {
          pushStage({ kind: "plan", label: "Planning the work" });
          plan = await planReplTurn({
            goal: goalText,
            history: historyRef.current,
            ai: activeAiRef.current,
            // The planner is a coordinator stage — run it on the triage model.
            model: triageModelRef.current,
            codeGraph: codeGraphRef.current,
            memory: turnMemory,
            agents: [...agentsRef.current.values()],
            signal: runner.signal,
          });
          noteProgress();
        }
        // Seed the Task Progress checklist with the plan's real tasks.
        for (const t of plan.tasks) {
          taskRegistry.upsert(t.id, {
            title: t.title,
            status: "pending",
            ...(t.agent ? { detail: `agent: ${t.agent}` } : {}),
          });
        }

        // ── Plan-only gate (the /plan command) ───────────────────────────────
        // When plan-only mode is ON the turn STOPS here: the plan renders for
        // inspection and the seeded tasks stay PENDING in the Task Progress
        // panel (planOnlyExit skips the finally's finalizeOpen). `/plan run`
        // stashes this exact prompt text in planRunOverrideRef — matching on
        // equality (not a boolean) so an unrelated queued prompt can never
        // consume the one-shot bypass.
        {
          const bypass = planRunOverrideRef.current === submission;
          if (bypass) planRunOverrideRef.current = null;
          if (planOnlyRef.current && !bypass) {
            planOnlyExit = true;
            lastPlanOnlyRef.current = submission;
            const taskLines = plan.tasks.map(
              (t, i) =>
                `  ${i + 1}. ${t.title}${t.agent ? `  · agent: ${t.agent}` : ""}`,
            );
            turn.push({
              role: "assistant",
              content:
                `▤ Plan only — ${plan.tasks.length} task${plan.tasks.length === 1 ? "" : "s"}, nothing executed:\n` +
                taskLines.join("\n") +
                "\n\n/plan run executes this plan · refine the prompt to re-plan · /plan off resumes normal turns.",
              timestamp: Date.now(),
            });
            render();
            return;
          }
        }

        // ── Fan out ──────────────────────────────────────────────────────────
        // A multi-task plan runs as a fleet of parallel subagents (each in its
        // own worktree, merged back) — the same machinery as `oxagen agents`,
        // driven from inside the TUI. A single-task plan stays in the
        // history-aware main loop below.
        if (plan.tasks.length > 1 && !bareRef.current) {
          pushStage({
            kind: "plan",
            label: `Planned ${plan.tasks.length} tasks — dispatching subagents`,
            detail: plan.tasks
              .map((t) => t.title)
              .join(" · ")
              .slice(0, 160),
          });
          hudHandle?.update({ detail: `fleet: ${plan.tasks.length} tasks` });
          const fleetHandles = new Map<string, AgentHandle>();
          // The live fleet's per-task cancel surface, captured via onFleet so
          // each subagent's registry row can carry a REAL abort handle (the
          // swarm panel's Ctrl-X kill and the global gesture route through it).
          let cancelFleetTask: ((id: string) => void) | null = null;
          try {
            // Subagents work silently for minutes between onTask lifecycle
            // events — defer the inactivity guard for the whole fleet run (each
            // subagent turn carries its own guard).
            fleetInFlight = true;
            const fleetResult = await runFleetTurn({
              plan,
              cwd,
              ai: activeAiRef.current,
              // A pinned /worker-model must win for every fanned-out task too —
              // see fleet-turn.ts's override. undefined ⇒ auto (per-task tiering).
              workerModel: modelRef.current ?? undefined,
              memory: fleetMemoryRef.current,
              serverMemory: serverMemoryRef.current,
              store: planStoreRef.current,
              projectContext: projectContextRef.current,
              agents: agentsRef.current,
              readOnly: modeRef.current === "readonly",
              signal: runner.signal,
              // Resource-aware swarm sizing: the orchestrator consults this at
              // every slot refill and clamps to [1, concurrency] — memory/CPU
              // pressure shrinks the swarm without touching queued tasks.
              concurrency: FLEET_TURN_CONCURRENCY,
              concurrencyProvider: () =>
                resourceMonitorRef.current?.effectiveConcurrency(
                  FLEET_TURN_CONCURRENCY,
                ) ?? FLEET_TURN_CONCURRENCY,
              onFleet: (fleet) => {
                cancelFleetTask = (id) => fleet.cancelTask(id);
              },
              onTask: (ev) => {
                if (runner.signal.aborted) return;
                noteProgress();
                // Task Progress checklist mirrors the fleet task lifecycle.
                taskRegistry.update(ev.taskId, {
                  status:
                    ev.status === "running"
                      ? "in_progress"
                      : ev.status === "done"
                        ? "done"
                        : ev.status === "queued"
                          ? "pending"
                          : "failed",
                  ...(ev.error
                    ? { detail: ev.error.slice(0, 80) }
                    : ev.summary
                      ? { detail: ev.summary.slice(0, 80) }
                      : {}),
                });
                // Agent Team panel: one live row per spawned subagent — with a
                // real abort handle so Ctrl-X kills cancel the fleet task.
                if (ev.status === "running" && !fleetHandles.has(ev.taskId)) {
                  fleetHandles.set(
                    ev.taskId,
                    agentRegistry.register({
                      kind: "subagent",
                      title: ev.title,
                      model: ev.model,
                      ...(ev.agent ? { detail: `agent: ${ev.agent}` } : {}),
                      abort: () => cancelFleetTask?.(ev.taskId),
                    }),
                  );
                } else if (ev.status !== "running" && ev.status !== "queued") {
                  fleetHandles
                    .get(ev.taskId)
                    ?.done(ev.status === "done" ? "done" : "failed");
                  const note = ev.summary ?? ev.error;
                  closeStreamingBlocks();
                  turn.push({
                    role: "tool",
                    toolName: "subagent",
                    content: `${ev.title} — ${ev.status}${note ? `: ${note.slice(0, 120)}` : ""}`,
                    timestamp: Date.now(),
                  });
                  render();
                }
              },
              onUpdate: (snap) => {
                if (runner.signal.aborted) return;
                noteProgress();
                for (const a of snap.agents) {
                  if (a.status === "running") {
                    fleetHandles.get(a.taskId)?.update({
                      ...(a.lastTool
                        ? { detail: `${a.lastTool} · ${a.steps} steps` }
                        : {}),
                      outputTokens: a.usage.outputTokens,
                      costUsd: a.usage.costUsd,
                    });
                  }
                }
              },
            });

            closeStreamingBlocks();
            turn.push({
              role: "assistant",
              content: fleetResult.summaryText,
              timestamp: Date.now(),
            });
            render();
            // Fleet turns bypass runTurn, so extend the conversation history
            // manually — the next turn's planner and loop both see the outcome.
            historyRef.current = [
              ...historyRef.current,
              { role: "user", content: submission },
              { role: "assistant", content: fleetResult.summaryText },
            ];
            void debugLog("turn", "turn.end", {
              mode: "repl-fleet",
              tasks: plan.tasks.length,
              failed: fleetResult.failedCount,
            });
            setTurns((n) => n + 1);
            return;
          } finally {
            fleetInFlight = false;
            // Retire any still-open subagent rows (cancelled mid-flight, or a
            // thrown error) so the Agent Team panel never leaks a spinner.
            for (const h of fleetHandles.values()) h.done();
          }
        }

        // Single-task plan: the main history-aware loop IS that task's agent.
        activePlanTaskId = plan.tasks[0]?.id ?? null;
        if (activePlanTaskId)
          taskRegistry.update(activePlanTaskId, { status: "in_progress" });

        // Per-turn dollar budget (session-scoped; /budget or --budget/--budget-mode).
        // Built fresh for this turn — a fresh model + a fresh "warn once" flag —
        // and createTurnBudgetGuard returns undefined when the policy is off, so
        // runTurn sees NO guard at all rather than a no-op one.
        let budgetGraceWarned = false;
        const budgetGuard = createTurnBudgetGuard(
          budgetRef.current,
          // Auto-routed turns are priced at the default (balanced) rate — the
          // routed model isn't known until the pipeline's ROUTE stage. Same
          // assumption the one-shot path makes (one-shot.ts buildBudgetGuard).
          modelRef.current ?? resolveModelId(),
          {
            // "grace" mode: at most once per turn is plenty of noise.
            onWithinGrace: (verdict: TurnBudgetVerdict) => {
              if (budgetGraceWarned) return;
              budgetGraceWarned = true;
              pushAssistant(
                `⚠︎ Over budget — within grace window (${formatBudgetUsd(verdict.costUsd)} / ` +
                  `ceiling ${formatBudgetUsd(verdict.ceilingUsd)}).`,
              );
            },
            // "prompt" mode: the turn hit the limit — ask via the same overlay
            // component the permission broker uses (see budgetPause above), not
            // its resolveApproval (which persists "remember" rules to settings).
            onPause: (verdict: TurnBudgetVerdict) =>
              new Promise<boolean>((resolve) => {
                setBudgetPause({
                  req: {
                    tool: "bash",
                    cwd,
                    reason: "⛔ per-turn budget",
                    summary:
                      `Reached ${formatBudgetUsd(verdict.costUsd)} of ${formatBudgetUsd(verdict.limitUsd)} — ` +
                      `continue for another ${formatBudgetUsd(verdict.limitUsd)}?`,
                  },
                  resolve,
                });
              }),
            onStop: (verdict: TurnBudgetVerdict) => {
              closeStreamingBlocks();
              pushAssistant(
                `⛔ Per-turn budget reached — stopped at ${formatBudgetUsd(verdict.costUsd)} of ` +
                  `${formatBudgetUsd(verdict.limitUsd)} (${TURN_BUDGET_MODES[verdict.mode].label}).`,
              );
            },
          },
        );

        const result = await runTurn({
          // Paste placeholders (`[Text #N]`) expand to their full stored
          // text here — the model sees the real content even though the
          // transcript above and the HUD title stay on the compact `submission`.
          prompt: paste?.expandedText ?? submission,
          images: images.length > 0 ? images : undefined,
          history: historyRef.current,
          workspace: createGatedWorkspace(
            workspaceRef.current,
            brokerRef.current ?? undefined,
          ),
          ai: activeAiRef.current,
          // null ⇒ auto: the pipeline's selectModel routes this turn to the
          // cheapest sufficient tier, with the precise safety floor for
          // auth/billing/security/migration work. The scope card shows the
          // routed model + rationale. An explicit pin passes through verbatim.
          model: modelRef.current ?? undefined,
          // Clarification surveys: interactive turns may ask the user a
          // structured question instead of guessing. Passing the callback is
          // the whole gate — the engine registers the ask_user tool and its
          // prompt rule only when present (headless/one-shot never pass it).
          askUser: (q) =>
            new Promise<AskUserResponse>((resolve) =>
              setPendingSurvey({
                question: q.question,
                options: q.options,
                resolve,
              }),
            ),
          // Per-function overrides (undefined ⇒ engine default for that role).
          // Judge takes a panel-shaped list; a single slug is a one-judge panel.
          judgeModels: judgeModelRef.current
            ? [judgeModelRef.current]
            : undefined,
          triageModel: triageModelRef.current,
          effort: effortRef.current,
          readOnly: modeRef.current === "readonly",
          bare: bareRef.current,
          verbose: verboseRef.current,
          budgetGuard,
          enhanceTimeoutMs,
          projectContext: projectContextRef.current,
          memory: turnMemory,
          codeGraph: codeGraphRef.current,
          trace: traceStoreRef.current,
          signal: runner.signal,
          // Always surface the pre-execution snapshot as a scope card in the
          // transcript, so the user ALWAYS sees both their original prompt and
          // the enhanced version the agent will run, plus the routed model and
          // an estimated cost — no setting required (feature 2). Long prompts
          // render truncated; Ctrl-O expands them (see ScopeCard).
          onScopeReview: (info) => {
            if (runner.signal.aborted) return;
            noteProgress();
            closeStreamingBlocks();
            turn.push({
              role: "scope",
              scope: info,
              content: "",
              timestamp: Date.now(),
            });
            render();
          },
          // The "confirm scope & cost" gate (feature 3/4): only when the
          // `confirmScope` setting is on, pause AFTER route / BEFORE execute and
          // hand the user the ScopeReview overlay to Run / Edit the enhanced
          // prompt / Cancel. Reads the setting fresh per turn (loadSettings is
          // process-cached) so toggling it in /config takes effect next turn.
          // Undefined when off ⇒ the engine runs with no gate at all.
          ...(loadSettings({ cwd }).settings.confirmScope === true
            ? {
                confirmScope: (info: ScopeReviewInfo) =>
                  new Promise<ScopeReviewDecision>((resolve) => {
                    // The overlay's own useInput drives the answer; releasing it
                    // on abort is handled by cancelTurn (see resolveScopeReview).
                    setScopeReview({ info, resolve });
                  }),
              }
            : {}),
          onStage: (stage) => {
            if (runner.signal.aborted) return;
            noteProgress();
            // Heartbeat: name what's happening now so a silent step still tells
            // the user what it's doing (feature 1).
            lastActivityRef.current = stage.detail ?? stage.label;
            void debugLog("turn", "turn.stage", {
              label: stage.label,
              detail: stage.detail,
            });
            // Keep the HUD's live detail on the current stage.
            hudHandle?.update({ detail: stage.detail ?? stage.label });
            // Advance the active planned task's live detail to this stage.
            recordStageTask(stage.kind, stage.detail ?? stage.label);
            // Full-screen TURN/MODELS dock — phase, revise round, and any
            // model slug this stage reveals (see telemetry.ts).
            dispatchTelemetry({ type: "stage", stage });
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
            if (runner.signal.aborted) return;
            // The tool is now EXECUTING — silence until it returns is expected,
            // so the inactivity guard defers while the count is non-zero.
            inFlightTools++;
            ciProbe.noteToolCall(name, input);
            noteProgress();
            // Files Touched store: reads count as touches (creates/updates
            // land via onFileEdit below; deletes are detected at hydrate).
            if (name === "read_file") {
              const p = (input as { path?: unknown } | null)?.path;
              if (typeof p === "string") noteTouch(p, "R");
            }
            // Heartbeat: an executing tool is the classic silent stretch — name
            // it (e.g. "bash · pnpm test") so the indicator shows what's running.
            lastActivityRef.current = summarizeInput(name, input);
            void debugLog("turn", "turn.tool-call", { name, input });
            // Full-screen TURN/TOOLS dock — step count (a live proxy for the
            // engine's own step counter) and per-tool call tallies.
            dispatchTelemetry({ type: "tool-call", name });
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
          onToolEvent: (e) => {
            // Tool finished — real progress; the in-flight deferral ends here.
            inFlightTools = Math.max(0, inFlightTools - 1);
            if (runner.signal.aborted) return;
            noteProgress();
            void debugLog("turn", "turn.tool-done", {
              name: e.name,
              ok: e.ok,
              durationMs: e.durationMs,
            });
          },
          onReasoning: (delta) => {
            if (runner.signal.aborted) return;
            noteProgress();
            // Reasoning tokens are billed output — feed the live burn estimate
            // (real usage supersedes it when the call settles).
            metricsBusRef.current.noteStreamChars(delta.length);
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
            if (runner.signal.aborted) return;
            noteProgress();
            streamCharsRef.current += delta.length;
            // Live burn: tick the status line/dock while the worker streams,
            // instead of only when the call's usage settles.
            metricsBusRef.current.noteStreamChars(delta.length);
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
          onFileEdit: ({ path, kind }) => {
            if (runner.signal.aborted) return;
            noteProgress();
            noteTouch(path, kind === "create" ? "C" : "U");
            // Show THIS file's diff the moment the edit lands (traditional
            // git-diff styling, themed to the terminal background) instead of
            // waiting for the round's cumulative final diff.
            const rel = normalizeTouchPath(path, cwd);
            void getFileDiff(cwd, {
              path: rel,
              status: kind === "create" ? "?" : "M",
              untracked: kind === "create",
            }).then((diff) => {
              if (runner.signal.aborted || !diff.trim()) return;
              // A repeat edit that lands the same cumulative diff (or an
              // edit git can't see) adds nothing — don't re-push.
              if (lastEditDiff.get(rel) === diff) return;
              lastEditDiff.set(rel, diff);
              editDiffsShown.add(rel);
              closeStreamingBlocks();
              turn.push({
                role: "diff",
                content: "",
                diff,
                changedFiles: [rel],
                timestamp: Date.now(),
              });
              render();
            });
          },
          onFileChange: (diff, changedFiles) => {
            if (runner.signal.aborted) return;
            noteProgress();
            // Render the code changes as a syntax-highlighted diff message, so
            // the user sees exactly what changed — themed to the terminal
            // background. Skip empty diffs (no textual change to show), and
            // skip entirely when every changed file's diff already streamed
            // per-edit above — the final diff would only repeat what's on
            // screen. (changedFiles also carries the user's own pre-existing
            // working-tree edits, which were never shown per-edit; a round
            // with any of those still surfaces the full diff here.)
            if (!diff.trim()) return;
            if (
              editDiffsShown.size > 0 &&
              changedFiles.every((f) =>
                editDiffsShown.has(normalizeTouchPath(f, cwd)),
              )
            ) {
              return;
            }
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
            // The score must never appear without its justification: surface
            // the judge's reasoning, falling back to its concrete findings /
            // remaining work when the verdict carries no prose.
            const lastJudge = judged
              ? t.judgeRounds[t.judgeRounds.length - 1]
              : undefined;
            const qualityReason = lastJudge
              ? lastJudge.reasoning?.trim() ||
                [
                  ...(lastJudge.findings ?? []),
                  ...(lastJudge.remainingWork ?? []),
                ].join("; ") ||
                undefined
              : undefined;
            turn.push({
              role: "assistant",
              content: "",
              timestamp: Date.now(),
              summary: {
                complete: t.finalComplete,
                quality: lastJudge?.confidence,
                qualityReason,
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
              content:
                "debug · enhanced prompt sent to the model:\n" + enhanced,
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
      } catch (err) {
        closeStreamingBlocks();
        // Distinguish the three exit paths: an explicit user cancel (Esc/Ctrl-C),
        // a timeout/stall (the turn deadline or stall detector fired on
        // turn runner with a typed AgentTimeoutError reason), or a real error.
        const userCancelled = controller.signal.aborted;
        const timeoutReason: unknown = runner.signal.aborted
          ? runner.signal.reason
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
            kind:
              timeoutReason instanceof AgentTimeoutError ? "timeout" : "error",
            message: content.replace(/^Error: /, ""),
            // Pass the raw value so debugLog captures name/message/stack for a
            // thrown Error; the timeout reason's message is already user-facing.
            error:
              timeoutReason instanceof AgentTimeoutError
                ? timeoutReason.message
                : err,
          });
        }
        turn.push({ role: "assistant", content, timestamp: Date.now() });
        render();
      } finally {
        // ONE final, untrottled flush: guarantees the very last streamed tokens
        // land immediately (no waiting out a pending ~33ms frame) and cancels
        // any pending frame timer for THIS turn so it can never fire late (e.g.
        // after unmount, or after a later turn has already claimed the shared
        // UI state below). Runs unconditionally — even a cancelled/aborted
        // turn's last committed content should land, not vanish mid-frame.
        renderThrottle.flush(() => [...base, ...turn]);
        if (renderThrottleRef.current === renderThrottle)
          renderThrottleRef.current = null;
        runner.stop();
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
          dispatchTelemetry({ type: "turn-end" });
          lastProgressRef.current = null;
          lastActivityRef.current = null;
          abortRef.current = null;
          streamingRef.current = false;
          setIsStreaming(false);
          setTurnStartedAt(null);
          // A survey pending when its turn ends (cancelled mid-question, or
          // the engine gave up waiting) must not leave a dead overlay or an
          // unresolved promise behind.
          setPendingSurvey((p) => {
            p?.resolve({
              answer:
                "(no answer — the turn ended before the user replied; proceed with your best judgment)",
              wasFreeText: true,
            });
            return null;
          });
          // Settle the Task Progress checklist so no step lingers half-lit. Guarded
          // on ownership so a cancelled turn's late finally never marks a newer
          // turn's freshly-cleared plan done. A plan-only exit skips this — the
          // pending tasks ARE the turn's output, kept inspectable until the next
          // turn's clear().
          if (!planOnlyExit) taskRegistry.finalizeOpen("done");
        }
      }
    },
    [
      exit,
      commit,
      pushAssistant,
      resetConversation,
      runShellCommand,
      cwd,
      options.readOnly,
    ],
  );

  // The pump reads the latest handleSubmit via a ref so it never closes over a
  // stale version, while staying a stable callback itself.
  const handleSubmitRef = useRef(handleSubmit);
  handleSubmitRef.current = handleSubmit;

  // ── Background-dispatch observer (docs/specs/repl-async-dispatch.md §3.5) ───
  // Mount once: watch the fleet store for the sessions THIS REPL spawned, fold
  // their completions into the transcript, and enforce the concurrency cap.
  // Reuses the ADR-023 session envelope — no second transport. `drainRef`
  // decouples the (stable) tracker from the per-render drain callback.
  useEffect(() => {
    const tracker = createBackgroundTracker({
      store: openFleetStore(fleetRoot(cwd)),
      maxConcurrent: dispatchCapRef.current,
      onNotify: (line) => pushAssistant(line),
      onRoster: (rows) => setBackgroundRows(rows),
      onSlotFree: () => drainRef.current(),
    });
    trackerRef.current = tracker;
    return () => {
      tracker.dispose();
      trackerRef.current = null;
    };
  }, [cwd, pushAssistant]);

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
        const next = queueRef.current[0] as QueuedPrompt;
        queueRef.current = queueRef.current.slice(1);
        setQueued(queueRef.current);
        try {
          await handleSubmitRef.current(next.text, next.paste);
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
    (text: string, paste?: PasteSubmission) => {
      queueRef.current = [...queueRef.current, { text, paste }];
      setQueued(queueRef.current);
      void pump();
    },
    [pump],
  );
  // Late-bind the /plan run resubmission seam (declared with the plan-only
  // state up top, long before enqueue exists). Reassigned every render —
  // enqueue is a stable callback, so this is effectively a one-time bind.
  resubmitRef.current = enqueue;

  // Every PromptInput submission funnels through here. The Esc-twice reset
  // confirmation must be answered SYNCHRONOUSLY — if we let it fall through to
  // `enqueue`, the "y" lands in the FIFO behind any unwinding turn and is then
  // run as an ordinary prompt (it visibly shows as "⧗ queued: y") instead of
  // confirming the reset. Intercepting it here consumes the keystroke as the
  // answer the instant the user hits Enter, never touching the queue.
  const handleUserSubmit = useCallback(
    (text: string, paste?: PasteSubmission) => {
      // Any deliberate submit clears a pending "press Ctrl-C again to exit" hint.
      lastCtrlCRef.current = null;
      clearCtrlCHint();
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
      // ── Busy-submit triage (dispatch-mode's "LLM triager v2") ──
      // A prompt submitted while a turn is streaming NEVER interrupts it: it is
      // enqueued immediately (the composer stays free, the work can't be lost),
      // then a small triage model asynchronously decides whether it should
      // instead start NOW as a detached background worker. "queue" (also the
      // deterministic fallback on any triage error/timeout) leaves it exactly
      // where FIFO put it; "background" pulls it back out — only if the pump
      // hasn't started it — and dispatches it. Slash commands, pasted-image
      // prompts (images can't ride a detached worker), plan-only mode, and
      // Dispatch mode (which has its own deterministic routing) all skip triage.
      if (
        streamingRef.current &&
        !text.startsWith("/") &&
        paste === undefined &&
        !dispatchModeRef.current &&
        !planOnlyRef.current
      ) {
        enqueue(text, paste);
        void triagePrompt({
          text,
          activeSummary:
            lastActivityRef.current ?? "an agent turn is streaming",
          queueDepth: queueRef.current.length,
          ai: activeAiRef.current,
          ...(triageModelRef.current ? { model: triageModelRef.current } : {}),
        })
          .then((decision) => {
            if (decision.route === "background") {
              // Pull it back out only if it is still waiting its FIFO turn.
              const idx = queueRef.current.findIndex((q) => q.text === text);
              if (idx === -1) return; // already started (or recalled) — leave it
              queueRef.current = [
                ...queueRef.current.slice(0, idx),
                ...queueRef.current.slice(idx + 1),
              ];
              setQueued(queueRef.current);
              dispatchToBackground(text);
              pushAssistant(`⚖ triage: backgrounded — ${decision.reason}`);
            } else if (decision.route === "clarify") {
              pushAssistant(`⚖ triage: kept in the queue — ${decision.reason}`);
            }
          })
          .catch(() => {
            // triagePrompt never throws by contract; the enqueued prompt runs
            // FIFO regardless, so there is nothing to recover here.
          });
        return;
      }
      enqueue(text, paste);
    },
    [
      enqueue,
      dispatchToBackground,
      resetConversation,
      pushAssistant,
      setEditingTaskId,
      clearCtrlCHint,
    ],
  );

  // ── Transcript rendering: Static history + live frame ───────────────────────
  // The REPL renders inline (normal screen buffer — see launchRepl). A message
  // is "live" for exactly as long as it is being streamed into (`streaming:
  // true`), and that is true for at most the LAST element of `messages` at any
  // time (closeStreamingBlocks always closes the previous block before a new one
  // opens). Everything before that is finished and handed to `<Static>`, which
  // commits it to the terminal's real scrollback exactly once and never
  // re-renders it — so a closed-over message must never be mutated again, or
  // Static would have already printed a stale snapshot of it. The live message
  // (if any) re-renders every frame in the small dynamic frame below, alongside
  // the prompt bar and side panels; once it closes it moves into `committed` on
  // the next render and is never drawn in both places at once (see
  // interactive.transcript.test.tsx for the regression guard).
  const lastMessage =
    messages.length > 0 ? messages[messages.length - 1] : undefined;
  const liveMessage = lastMessage?.streaming ? lastMessage : undefined;
  // Memoized so identity is stable across renders that don't touch `messages`
  // (e.g. the 1Hz clock tick) — a bare `.slice` would allocate a fresh array
  // every render even when the underlying messages haven't changed, which
  // would defeat the row-height memoization below.
  const committedMessages = useMemo(
    () => (liveMessage ? messages.slice(0, -1) : messages),
    [messages, liveMessage],
  );

  // Estimated on-screen row height per COMMITTED message, recomputed only
  // when the committed transcript or viewport width actually changes — not on
  // every render. Previously the full-screen branch below re-measured the
  // ENTIRE transcript (including scrollback long off-screen) on every render,
  // including the idle 1Hz clock tick and every streamed token. Computed
  // unconditionally (not inside `if (fullscreen)`) so this hook always runs in
  // the same order across renders; it's simply unused off a TTY.
  const fullscreenViewportWidth = Math.max(
    20,
    cols - (cols >= SIDEBAR_MIN_COLS ? 36 : 0),
  );
  const committedRowHeights = useMemo(
    () =>
      committedMessages.map((m) =>
        estimateMessageRows(m, fullscreenViewportWidth),
      ),
    [committedMessages, fullscreenViewportWidth],
  );

  // ── Full-screen TUI render (real TTY only) ──────────────────────────────
  // A fundamentally different rendering model from inline mode below: the
  // alternate screen buffer has no scrollback, so `<Static>` (print once,
  // never touch again) would silently lose any message that scrolls off the
  // top — there'd be nowhere to scroll BACK to. Every message instead stays
  // in normal React state and TranscriptViewport re-slices it each render
  // according to the live scroll offset, which is also what makes in-app
  // scroll possible at all. See scroll.ts / fullscreen-chrome.tsx.
  if (fullscreen) {
    // Reserve room for the sidebar only when it COULD be showing (mirrors
    // AgentSidebar's own MIN_TERMINAL_COLS gate) — an estimate (its exact
    // PANEL_WIDTH isn't exported), generous enough that the transcript never
    // visually collides with a docked sidebar. Computed above (unconditionally)
    // as `fullscreenViewportWidth` so the row-height useMemo can key on it;
    // aliased here under its original name to keep this block's diff minimal.
    const viewportWidth = fullscreenViewportWidth;
    // The persistent sunset banner (gradient wordmark only — version and
    // org/workspace scope live in the HeaderBar below it) is pinned at the
    // top of the frame — the alt screen has no scrollback, so
    // "persists like Claude Code" means keeping it rendered every frame. On
    // short terminals it's dropped entirely so the transcript keeps usable
    // height.
    const showBanner = rows >= 24;
    // Fixed chrome: banner (when shown) + header(1) + status row(1) +
    // input(3) + dock(6) + a single trailing margin row(1) so the dock is
    // never flush to the bottom edge.
    // Rare conditional banners (queued prompts, the reset-confirm prompt, the
    // HUD, a drilled-in agent log) aren't budgeted for individually — Yoga
    // shrinks the transcript row to make room, and TranscriptViewport's own
    // `overflow: hidden` is the safety net, so an occasional banner can
    // clip a row or two off the bottom of the transcript rather than corrupt
    // the frame.
    const CHROME_ROWS = 12 + (showBanner ? bannerRowCount() : 0);
    const transcriptOuterHeight = Math.max(4, rows - CHROME_ROWS);
    const transcriptContentHeight = Math.max(1, transcriptOuterHeight - 1);
    // Sum of the memoized committed row heights plus the live (streaming)
    // message's own height, computed fresh each render (it's a single message,
    // O(1) — the O(N) cost is the committed-heights memo above, not this).
    const committedTotalLines = committedRowHeights.reduce((a, b) => a + b, 0);
    const liveRows = liveMessage
      ? estimateMessageRows(liveMessage, viewportWidth)
      : 0;
    // Written during render (same "latest value" convention as modelRef.current
    // = model elsewhere in this file) so the NEXT dispatch — from the very next
    // keystroke or wheel tick — clamps against this frame's content size.
    scrollCtxRef.current = {
      totalLines: committedTotalLines + liveRows,
      viewportHeight: transcriptContentHeight,
    };

    return (
      <Box flexDirection="column" height={rows} width={cols} overflow="hidden">
        {showBanner && <Banner />}
        <LiveClock
          render={(now) => (
            <HeaderBar
              model={model ?? "auto"}
              version={pkg.version}
              scope={`${session.orgSlug}/${session.workspaceSlug}`}
              branch={repoInfo.branch}
              sessionLabel={repoInfo.root.split("/").pop() || "session"}
              sessionCostUsd={metrics.sessionCostUsd}
              now={now}
              dispatchMode={dispatchMode}
            />
          )}
        />

        <Box flexDirection="row" flexGrow={1} overflow="hidden">
          {/* overflow=hidden: wide unbreakable content (e.g. a terminal run's
              long command line) must clip inside this column rather than
              inflate its flex basis and squeeze the fixed-width sidebar —
              which would amputate the sidebar panels' right border. */}
          <Box
            flexDirection="column"
            flexGrow={1}
            minWidth={0}
            overflow="hidden"
          >
            {terminalRun && <TerminalPanel run={terminalRun} />}
            <TranscriptViewport
              committedMessages={committedMessages}
              liveMessage={liveMessage}
              diffTheme={diffThemeRef.current}
              width={viewportWidth}
              height={transcriptOuterHeight}
              scroll={scrollState}
            />
          </Box>
          <AgentSidebar
            mode={panelMode}
            focus={focus.zone === "input" ? null : focus}
            active={focus.zone !== "input"}
            maxRows={Math.max(6, transcriptOuterHeight)}
          />
        </Box>

        {queued.length > 0 && (
          <Box flexDirection="column" paddingX={1}>
            {queued.map((q, i) => (
              <Box key={i}>
                <Text color="#FBBF24">{"⧗ queued: "}</Text>
                <Text dimColor wrap="truncate">
                  {q.text}
                </Text>
              </Box>
            ))}
          </Box>
        )}

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

        {ctrlCArmed && (
          <Box paddingX={1}>
            <Text dimColor>press Ctrl-C again to exit</Text>
          </Box>
        )}

        {hudVisible && <HudPanel />}
        <BackgroundPanel rows={backgroundRows} />
        {focusedAgentId && <AgentFocusView agentId={focusedAgentId} />}
        {editingTaskId && (
          <Box paddingX={1}>
            <Text color={theme.violet}>
              ✎ Editing task — Enter saves the title, Esc cancels.
            </Text>
          </Box>
        )}

        {/* Status row (1 row): the invaders duel doubles as the signature
            animation, plus a compact elapsed readout while a turn streams.
            /motion gates both: the duel is decorative (full only); the
            elapsed readout is the fullscreen thinking indicator (off hides it). */}
        <Box paddingX={1}>
          {motion === "full" ? <SpaceInvaders active={isStreaming} /> : null}
          {motion !== "off" && isStreaming && turnStartedAt !== null ? (
            <LiveClock
              render={(now) => (
                <Text color="#FBBF24">
                  {"  thinking… "}
                  {formatElapsed(now - turnStartedAt)}
                </Text>
              )}
            />
          ) : null}
        </Box>

        <Box flexShrink={0} flexDirection="column">
          {approval ? (
            <ApprovalPrompt req={approval.req} onResolve={resolveApproval} />
          ) : budgetPause ? (
            <ApprovalPrompt
              req={budgetPause.req}
              onResolve={resolveBudgetPause}
            />
          ) : pendingSurvey ? (
            <SurveyPrompt
              question={pendingSurvey.question}
              options={pendingSurvey.options}
              width={Math.min(cols - 2, 100)}
              onAnswer={(a) => {
                pendingSurvey.resolve(a);
                setPendingSurvey(null);
              }}
            />
          ) : scopeReview ? (
            <ScopeReview
              info={scopeReview.info}
              onDecision={resolveScopeReview}
              width={Math.min(cols - 2, 100)}
              expanded={detailExpanded}
            />
          ) : tasksOpen ? (
            <TasksPanel
              onClose={closeOverlayPanels}
              width={Math.min(cols - 2, 100)}
            />
          ) : swarmOpen ? (
            <SwarmPanel
              onClose={closeOverlayPanels}
              onKill={(id) => agentRegistry.kill(id)}
              width={Math.min(cols - 2, 100)}
            />
          ) : marketplaceOpen ? (
            <MarketplacePanel
              onClose={closeOverlayPanels}
              client={marketplaceClient}
              width={Math.min(cols - 2, 100)}
            />
          ) : promptsOpen ? (
            <PromptsPanel
              prompts={promptsList}
              onClose={closeOverlayPanels}
              onInsert={injectText}
              onCreateNew={() => openCreateWizard("prompt")}
              width={Math.min(cols - 2, 100)}
            />
          ) : createKind !== null ? (
            <CreateWizard
              kind={createKind}
              onClose={closeOverlayPanels}
              onCreated={handleCreated}
              scaffold={scaffoldForKind}
              openInEditor={openTouchedInEditor}
              width={Math.min(cols - 2, 100)}
            />
          ) : diffOpen ? (
            <DiffPanel
              cwd={cwd}
              onClose={closeDiffPanel}
              width={Math.min(cols - 2, 100)}
              maxBodyRows={Math.max(8, rows - 18)}
              initialPath={diffInitialPath}
            />
          ) : filesOpen ? (
            <FilesPanel
              cwd={cwd}
              entries={Array.from(filesTouchedRef.current.values())}
              onClose={closeFilesPanel}
              onShowDiff={showDiffForTouched}
              onOpenFile={openTouchedInEditor}
              width={Math.min(cols - 2, 100)}
            />
          ) : configOpen ? (
            <ConfigPanel
              cwd={cwd}
              onClose={closeConfigPanel}
              width={Math.min(cols - 2, 100)}
            />
          ) : loginOpen ? (
            <LoginPanel
              onClose={closeLoginPanel}
              onLoggedIn={handleLoggedIn}
              width={Math.min(cols - 2, 100)}
            />
          ) : (
            <PromptInput
              onSubmit={handleUserSubmit}
              busy={isStreaming}
              borderColor={promptBorderColor}
              mouseRow={promptMouseRow}
              mouseEnabled={promptMouseEnabled}
              catalog={catalog}
              focused={focus.zone === "input"}
              inject={inject}
              onMenuOpenChange={handleMenuOpenChange}
              onEmptyChange={handleEmptyChange}
              onOpenLastTouched={openLastTouchedInEditor}
            />
          )}
        </Box>

        <Box marginBottom={1} flexShrink={0}>
          <LiveClock
            render={(now) => (
              <TelemetryDock
                telemetry={telemetry}
                metrics={metrics}
                cacheHit={metrics.sessionCachedTokens}
                isStreaming={isStreaming}
                now={now}
                cols={cols}
                repo={repoInfo}
              />
            )}
          />
        </Box>
      </Box>
    );
  }

  return (
    <>
      {/* Finished transcript — printed once each, permanently, into the
          terminal's real scrollback. Never re-rendered once flushed (see the
          comment above), which is what makes native scroll-up work. The
          banner rides as the permanent first item so it commits to real
          scrollback the moment the app opens and stays there for the whole
          session — the same persistence model as Claude Code's header. */}
      <Static items={["banner" as const, ...committedMessages]}>
        {(item, i) =>
          item === "banner" ? (
            <Banner key="banner" />
          ) : (
            <MessageView
              key={i}
              msg={item}
              diffTheme={diffThemeRef.current}
              expanded={detailExpanded}
            />
          )
        }
      </Static>

      {/* Live frame — everything that still changes from tick to tick: the
          in-progress message, terminal panel, side panels, prompt bar, and
          status line. This is the CLASSIC INLINE render — reached only when
          `fullscreen` is false (the full-screen branch above returns before
          ever getting here) — so it's kept to its NATURAL (small) height with
          no hard cap: the terminal's own scrollback absorbs anything tall,
          exactly as it would for `less` or any other normal-buffer program.
          `justifyContent="flex-end"` keeps the prompt bar/status pinned to the
          bottom of this live region as it grows. */}
      <Box flexDirection="column" justifyContent="flex-end">
        {messages.length === 0 && (
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
        )}

        <Box flexDirection="row" flexShrink={1} overflow="hidden">
          {/* overflow=hidden: wide unbreakable content must clip inside this
              column rather than inflate its flex basis and squeeze the
              fixed-width sidebar, which would clip the panels' right border. */}
          <Box
            flexDirection="column"
            flexGrow={1}
            minWidth={0}
            overflow="hidden"
          >
            {/* Terminal panel — a `!command`'s live stdout/stderr, red-outlined and
                pinned just ABOVE the in-progress message so shell output stays
                visually separate from the agent speaking. Null until a command
                has run. */}
            {terminalRun && <TerminalPanel run={terminalRun} />}

            {/* The one message still being streamed into, if any. */}
            {liveMessage && (
              <MessageView
                msg={liveMessage}
                diffTheme={diffThemeRef.current}
                expanded={detailExpanded}
              />
            )}
          </Box>

          {/* Agent Team (live roster) + Task Progress (the planning agent's
              checklist). Renders nothing until there's work to show. `focus`
              highlights the navigated-to row and `active` forces the dock
              visible while it holds focus, so arrow-nav / Ctrl-E drill-in /
              Ctrl-X never land on a hidden or unmarked list. */}
          <AgentSidebar
            mode={panelMode}
            focus={focus.zone === "input" ? null : focus}
            active={focus.zone !== "input"}
            maxRows={fullscreen ? Math.max(6, rows - 8) : undefined}
          />
        </Box>

        {/* Transient notices, then the input row, then the status line. */}

        {/* Dispatch-mode indicator (inline branch — the full-screen HeaderBar
          shows its own). Present whenever the async autopilot is on, even with
          nothing dispatched yet, so the mode is never invisible. */}
        {dispatchMode && (
          <Box paddingX={1}>
            <Text color={theme.violet} bold>
              {"⇉ dispatch"}
            </Text>
            <Text
              dimColor
            >{` · task prompts run in the background (cap ${dispatchCapRef.current})`}</Text>
          </Box>
        )}

        {/* Queued prompts (submitted while a turn is running) */}
        {queued.length > 0 && (
          <Box flexDirection="column" paddingX={1}>
            {queued.map((q, i) => (
              <Box key={i}>
                <Text color="#FBBF24">{"⧗ queued: "}</Text>
                <Text dimColor wrap="truncate">
                  {q.text}
                </Text>
              </Box>
            ))}
          </Box>
        )}

        {/* Thinking indicator — visible only while a turn is in flight (and
          animation isn't fully disabled via /motion off). */}
        {motion !== "off" && isStreaming && turnStartedAt !== null && (
          <ThinkingIndicator
            startedAt={turnStartedAt}
            getTokens={() => Math.round(streamCharsRef.current / 4)}
            getLastProgressAt={() => lastProgressRef.current}
            getActivity={() => lastActivityRef.current}
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

        {/* Idle Ctrl-C double-press hint — a lone idle Ctrl-C arms exit rather
          than quitting outright (so typed-but-unsent input is never lost). */}
        {ctrlCArmed && (
          <Box paddingX={1}>
            <Text dimColor>press Ctrl-C again to exit</Text>
          </Box>
        )}

        {/* Heads-up display — every agent running this session. Toggled by /hud
          (and closed by Esc); sits just above the input as a live status overlay. */}
        {hudVisible && <HudPanel />}
        <BackgroundPanel rows={backgroundRows} />

        {/* Drilled-in agent log — opened with Ctrl-E on an Agent Team row. It sits
          directly above the prompt bar (the bar is cleared and re-focused when
          it opens) and closes on Esc. Renders nothing once the agent is pruned. */}
        {focusedAgentId && <AgentFocusView agentId={focusedAgentId} />}

        {/* Task-edit hint — while editing a task title (Ctrl-E on a Task Progress
          row), Enter rewrites the task instead of sending a prompt. */}
        {editingTaskId && (
          <Box paddingX={1}>
            <Text color={theme.violet}>
              ✎ Editing task — Enter saves the title, Esc cancels.
            </Text>
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
          ) : budgetPause ? (
            <ApprovalPrompt
              req={budgetPause.req}
              onResolve={resolveBudgetPause}
            />
          ) : pendingSurvey ? (
            <SurveyPrompt
              question={pendingSurvey.question}
              options={pendingSurvey.options}
              width={Math.min((cols || 80) - 2, 100)}
              onAnswer={(a) => {
                pendingSurvey.resolve(a);
                setPendingSurvey(null);
              }}
            />
          ) : scopeReview ? (
            <ScopeReview
              info={scopeReview.info}
              onDecision={resolveScopeReview}
              width={Math.min((cols || 80) - 2, 100)}
              expanded={detailExpanded}
            />
          ) : tasksOpen ? (
            <TasksPanel onClose={closeOverlayPanels} />
          ) : swarmOpen ? (
            <SwarmPanel
              onClose={closeOverlayPanels}
              onKill={(id) => agentRegistry.kill(id)}
            />
          ) : marketplaceOpen ? (
            <MarketplacePanel
              onClose={closeOverlayPanels}
              client={marketplaceClient}
            />
          ) : promptsOpen ? (
            <PromptsPanel
              prompts={promptsList}
              onClose={closeOverlayPanels}
              onInsert={injectText}
              onCreateNew={() => openCreateWizard("prompt")}
            />
          ) : createKind !== null ? (
            <CreateWizard
              kind={createKind}
              onClose={closeOverlayPanels}
              onCreated={handleCreated}
              scaffold={scaffoldForKind}
              openInEditor={openTouchedInEditor}
            />
          ) : diffOpen ? (
            <DiffPanel
              cwd={cwd}
              onClose={closeDiffPanel}
              initialPath={diffInitialPath}
            />
          ) : filesOpen ? (
            <FilesPanel
              cwd={cwd}
              entries={Array.from(filesTouchedRef.current.values())}
              onClose={closeFilesPanel}
              onShowDiff={showDiffForTouched}
              onOpenFile={openTouchedInEditor}
            />
          ) : configOpen ? (
            <ConfigPanel cwd={cwd} onClose={closeConfigPanel} />
          ) : loginOpen ? (
            <LoginPanel onClose={closeLoginPanel} onLoggedIn={handleLoggedIn} />
          ) : (
            <PromptInput
              onSubmit={handleUserSubmit}
              busy={isStreaming}
              borderColor={promptBorderColor}
              mouseRow={promptMouseRow}
              mouseEnabled={promptMouseEnabled}
              catalog={catalog}
              focused={focus.zone === "input"}
              inject={inject}
              onMenuOpenChange={handleMenuOpenChange}
              onOpenLastTouched={openLastTouchedInEditor}
            />
          )}

          {/* Status line — below the input bar, with a blank row beneath it so it is
          never flush against the bottom edge of the window. A whimsical rocket
          duels a UFO on the rail above it while a turn is running (opt out
          with /motion reduced|off, or the legacy OXAGEN_CLI_FUN=0). */}
          <Box marginBottom={1} flexShrink={0} flexDirection="column">
            {motion === "full" ? <SpaceInvaders active={isStreaming} /> : null}
            <StatusLine
              model={model ?? "auto"}
              branch={branchRef.current}
              // Tokens + cost + cache all come from the live metrics bus (every
              // model call — evaluator, worker per-step, judge — contributes), so
              // they update together as calls complete during a turn and settle
              // correctly at the end (Bug 2) — cache used to lag behind on a
              // separate one-shot-per-turn total while tokens/cost updated live.
              inputTokens={metrics.sessionTokensIn}
              // `streamTokensOut` is the in-flight call's live ~chars/4 estimate;
              // it zeroes when the call's real usage lands, so these sums tick
              // during streaming and settle on exact totals (see metrics.ts).
              outputTokens={metrics.sessionTokensOut + metrics.streamTokensOut}
              cacheHit={metrics.sessionCachedTokens}
              cacheMiss={Math.max(
                0,
                metrics.sessionTokensIn - metrics.sessionCachedTokens,
              )}
              costUsd={metrics.sessionCostUsd}
              turnOutputTokens={metrics.turnTokensOut + metrics.streamTokensOut}
              turnCostUsd={metrics.turnCostUsd}
              pipelineOn={pipelineOn}
              verboseOn={verboseOn}
              effort={effort}
              mode={mode}
            />
          </Box>
        </Box>
        {/* end input row */}
      </Box>
      {/* end live frame */}
    </>
  );
}

// ── Launch ────────────────────────────────────────────────────────────────────

export async function launchRepl(options: ReplOptions): Promise<void> {
  const { render: renderInk } = await import("ink");
  // Resolve the CLI program factory once: injected by program.tsx normally,
  // lazy-imported here for callers that don't carry one (mission-control).
  // Dynamic on purpose — a static import would put the whole composition
  // root back into the REPL's static module graph (the exact coupling this
  // seam exists to cut).
  const buildProgram =
    options.buildProgram ?? (await import("../program.js")).buildProgram;
  options = { ...options, buildProgram };
  // On a real TTY, take over the alternate screen buffer: ReplApp renders a
  // full-screen dashboard (header/viewport/dock — see the `fullscreen` branch
  // of its render) with its OWN in-app scroll (scroll.ts), so it no longer
  // needs the terminal's native scrollback the way the classic inline mode
  // does. Off a TTY (tests, pipes) `useTerminalSize` reports `fullscreen:
  // false` and ReplApp falls back to the original inline render (finished
  // output committed via `<Static>`) — this branch is skipped entirely there,
  // so piped/test output is completely unaffected. `leave()` is called on
  // every exit path, including an uncaught error, so a crash never strands
  // the user's terminal in the alternate buffer — see interactive.launch.test.tsx
  // for the regression guard (now locking the OPPOSITE contract from before:
  // full-screen mode enters/leaves the alternate screen on a TTY, and still
  // never does off one).
  const isTTY = Boolean(process.stdout.isTTY);
  const fullscreenHandle = isTTY ? enterFullscreen(process.stdout) : null;
  if (fullscreenHandle) {
    // Best-effort net for abnormal termination (an uncaught exception,
    // `process.exit`) — the normal path's `finally` below already covers a
    // clean exit. `"exit"` does NOT fire on a signal kill (SIGTERM/SIGINT),
    // which is what the explicit handlers below are for.
    process.once("exit", fullscreenHandle.leave);
  }
  // Reaches into the live ReplApp instance's abortRef/terminalHandleRef/
  // renderThrottleRef — see ReplSignalHandle's doc comment for why a
  // process-level ref is the only way to do that from a signal handler.
  const signalHandleRef: { current: ReplSignalHandle | null } = {
    current: null,
  };
  // SIGTERM/SIGINT net: a signal kill previously left the terminal stranded
  // in the alternate screen buffer (with mouse tracking still armed) AND
  // leaked the in-flight turn's model call + any detached `!command` child
  // process group, because neither `waitUntilExit`'s `finally` nor any React
  // effect cleanup ever runs when the process is torn down by a signal —
  // only `"exit"` listeners (registered above) do, and `"exit"` itself is not
  // emitted for a signal kill. Restore the terminal FIRST (so the signal is
  // visibly handled even if reaping children is slow), then reap, then die by
  // re-raising the signal (still 128+n to the shell). NOT `process.exit`:
  // exit()-time C++ static destructors abort under duckdb/onnxruntime's live
  // worker threads — see exit-by-signal.ts for the crash anatomy.
  const onSignal = (signal: "SIGTERM" | "SIGINT"): void => {
    fullscreenHandle?.leave();
    signalHandleRef.current?.reapChildren();
    exitBySignal(signal);
  };
  const onSigterm = (): void => onSignal("SIGTERM");
  const onSigint = (): void => onSignal("SIGINT");
  process.on("SIGTERM", onSigterm);
  process.on("SIGINT", onSigint);
  try {
    const { waitUntilExit } = renderInk(
      <ReplApp options={options} signalHandleRef={signalHandleRef} />,
    );
    await waitUntilExit();
  } finally {
    fullscreenHandle?.leave();
    // Remove the signal handlers on a clean exit — `launchRepl` can run more
    // than once in the same process (e.g. a REPL restart from a command that
    // re-enters it), and process-level listeners are never garbage collected
    // on their own: leaving them registered would both leak a listener per
    // restart and mean an OLD instance's stale `onSignal` fires (still
    // pointing at a torn-down `fullscreenHandle`/`signalHandleRef`) alongside
    // every newer one on the next Ctrl-C.
    process.off("SIGTERM", onSigterm);
    process.off("SIGINT", onSigint);
  }
}
