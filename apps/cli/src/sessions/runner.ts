/**
 * The session runner (ADR-023) — runs ONE agent session end-to-end and turns
 * the engine's callbacks into the session event envelope, on BOTH the in-process
 * bus (for the Mission Control TUI) and the append-only disk log (for `--json`
 * pipes, a second terminal, and `jq`).
 *
 * This is the single wrapper the ADR calls for: "interactive and non-interactive
 * are the same program." The Ink TUI renders the bus; a headless worker's disk
 * log is tailed by another process. Parity is structural, not a feature to
 * maintain — every surface reads the SAME stream this runner emits.
 *
 * It mirrors the wiring assembled by {@link runOneShot} / {@link createEngineRunner}:
 * `buildTurnExtras` with `gatePermissions: true` (fleet sessions have no
 * interactive permission broker — the tool gate owns permissions), a metered
 * gateway AI port, the local code graph, project rules, and per-session memory.
 * The one behavioural addition is the conversation loop: after a turn settles the
 * runner tails its inbox and threads `history` into the next `runTurn`, so a
 * session survives past its first turn (ADR-023 decision 5).
 *
 * ## Bus vs disk (coalescing)
 *
 * `onLocalEvent` is invoked synchronously for EVERY event with RAW, uncoalesced
 * message/reasoning deltas — the TUI needs each byte as it streams. The DISK
 * copy of `message.delta`/`reasoning.delta` is coalesced (flush at 150 ms or
 * 2 KB, whichever first, and always at a turn boundary) so the log stays bounded
 * (ADR-023 consequences). A raw bus delta carries a PREVIEW `seq` equal to the
 * seq its coalesced disk chunk will claim on flush — coherent because a delta
 * flush is always the next disk append (a non-delta event flushes deltas first).
 *
 * The runner NEVER calls `process.exit`; it returns the session's fate so the
 * caller (the in-process manager, or the `fleet worker` entry) decides.
 */
import {
  runTurn,
  diffChangedLines,
  startMaxLifetime,
  startRssWatchdog,
  resolveBoundMs,
  resolveBoundBytes,
  type AgentAi,
  type BoundHandle,
} from "@oxagen/agent-engine";
import {
  createTurnBudgetGuard,
  formatBudgetUsd,
  TURN_BUDGET_MODES,
  type TurnBudgetPolicy,
  type TurnBudgetVerdict,
} from "@oxagen/billing/turn-budget";
import {
  createSessionRecorder,
  distillEvalItem,
  openRecordStore,
  readRun,
  reconstructHistory,
  type RecordStore,
  type SessionRecorder,
} from "@oxagen/replay";
import type { ModelMessage } from "ai";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import pkg from "../../package.json" with { type: "json" };
import {
  EVENT_SCHEMA_VERSION,
  addTurnUsage,
  capForWire,
  emptyTurnUsage,
  type SessionEvent,
  type SessionEventInput,
  type SessionState,
  type TurnUsage,
} from "./events.js";
import type {
  SessionMeta,
  SessionStore,
  SessionWriter,
  TailHandle,
} from "./store.js";
import { sessionDir } from "./paths.js";
import {
  createCodeGraphProvider,
  createCombinedMemory,
  createGatewayAgentAi,
  createServerMemory,
  createCwdWorkspace,
  type ServerMemory,
} from "../agent/adapters/index.js";
import { createMeteredAi } from "../agent/metered-ai.js";
import { queryCodeGraph } from "../agent/code-graph.js";
import { buildTurnExtras, type TurnExtras } from "../agent/turn-extras.js";
import { loadProjectContext } from "../agent/project-context.js";
import { openSessionMemory, type SessionMemory } from "../agent/memory.js";
import { openFleetMemory, type FleetMemory } from "../agent/fleet/memory.js";
import { createLocalFileLockProvider } from "../agent/fleet/local-file-lock.js";
import { accumulateUsage } from "../agent/model-router.js";
import { resolveModelId } from "../agent/model.js";
import {
  AgentTimeoutError,
  createTurnRunner,
  resolveTurnInactivityMs,
} from "../agent/timeouts.js";
import { createCiWaitProbe } from "../lib/ci-wait.js";
import { resolveApiContext } from "../lib/api.js";
import { loadSettings } from "../settings/resolve.js";
import { debugLog } from "../lib/debug-log.js";

/** Default idle window a conversation session waits for a follow-up before ending `done`. */
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
/**
 * Hard wall-clock ceiling for a detached worker session (default 2 h). The
 * existing stall/inactivity/idle aborts only catch a session that STOPS making
 * progress; a worker that keeps producing output can otherwise run unbounded.
 * This ceiling aborts it gracefully (terminal event + normal fate path).
 * Env-overridable via `OXAGEN_WORKER_MAX_LIFETIME_MS` (`0`/`off` disables).
 */
const DEFAULT_WORKER_MAX_LIFETIME_MS = 2 * 60 * 60 * 1000;
/**
 * RSS ceiling for a detached worker (default 4 GB). A long-lived worker whose
 * memory climbs — accumulating trace/history state — is aborted gracefully at
 * the ceiling rather than being OOM-killed mid-write. Env-overridable via
 * `OXAGEN_WORKER_MAX_RSS_MB` (megabytes; `0`/`off` disables).
 */
const DEFAULT_WORKER_MAX_RSS_BYTES = 4 * 1024 * 1024 * 1024;
/** Disk-coalescing flush cadence for text/reasoning deltas. */
const COALESCE_FLUSH_MS = 150;
/**
 * Disk-coalescing size cap: a buffered delta run this long flushes immediately.
 * Measured in JS string length (UTF-16 code units), not encoded bytes — the cap
 * exists to bound log-line size, and a code-unit count is the cheap upper-bound
 * proxy for it (multi-byte text flushes sooner than 2 KB, never later).
 */
const COALESCE_MAX_CHARS = 2048;

/** ADR-028: sidecar recording is default-on; `OXAGEN_FLEET_RECORD=0|off` disables. */
function isRecordingEnabled(): boolean {
  const value = process.env["OXAGEN_FLEET_RECORD"]?.toLowerCase();
  return value !== "0" && value !== "off";
}

export interface SessionRunnerOptions {
  /** The session store this session's log/meta/inbox live in. */
  store: SessionStore;
  /** The session's on-disk meta (from `createSession`) — prompt, cwd, owner, mode. */
  meta: SessionMeta;
  /**
   * Injected AI port. Omitted ⇒ the BYOK gateway-direct port (unmetered, as the
   * fleet uses), wrapped in the metered port for per-call timeout + retry. The
   * manager may inject the TUI session's platform-metered port instead.
   */
  ai?: AgentAi;
  /** Inject a fake `runTurn` in tests; defaults to the real engine loop. */
  runTurnImpl?: typeof runTurn;
  /** Clock injection for deterministic durations in tests. */
  now?: () => number;
  /** Idle window before a waiting conversation session ends `done` (default 30 min). */
  idleTimeoutMs?: number;
  /** Per-turn dollar budget; undefined ⇒ unbounded. */
  budgetPolicy?: TurnBudgetPolicy;
  /**
   * In-process bus tap. Invoked SYNCHRONOUSLY for every event, with RAW
   * (uncoalesced) message/reasoning deltas — the TUI's live stream. The disk
   * copy of deltas is coalesced independently.
   */
  onLocalEvent?: (event: SessionEvent) => void;
}

/** The fate of a completed session — what the caller reports / exits with. */
export type SessionFate = "done" | "failed" | "cancelled";

/** Outcome of running a single turn, consumed by the conversation loop. */
type TurnOutcome =
  | { kind: "ok"; result: Awaited<ReturnType<typeof runTurn>> }
  | { kind: "cancelled" }
  | { kind: "timeout"; message: string }
  | { kind: "error"; message: string };

/**
 * Run one session to completion. Emits the full envelope stream (bus + disk),
 * threads the inbox conversation loop, and always finalizes with a
 * `session.end` event + terminal meta in `finally`. Returns the session's fate;
 * never throws for an in-turn failure (those become `error` events + a `failed`
 * fate), only re-raising truly unexpected assembly errors after finalizing.
 */
export async function runSession(
  opts: SessionRunnerOptions,
): Promise<{ state: SessionFate }> {
  const { store, meta, onLocalEvent } = opts;
  const sid = meta.sid;
  const cwd = meta.cwd;
  const now = opts.now ?? Date.now;
  const runTurnImpl = opts.runTurnImpl ?? runTurn;
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const profile: "interactive" | "headless" =
    meta.owner === "worker" ? "headless" : "interactive";
  const startedAt = now();

  const writer: SessionWriter = store.openWriter(meta);

  // ── ADR-028 sidecar record: full tool I/O, per-turn history, fs layers ─────
  // Default-on for every fleet session. A recorder failure disables itself and
  // debug-logs once — it must never fail or slow the session it observes.
  const recordStore: RecordStore = openRecordStore(
    sessionDir(store.rootDir, sid),
  );
  const recorder: SessionRecorder | null = isRecordingEnabled()
    ? createSessionRecorder({
        store: recordStore,
        sid,
        cwd,
        ...(opts.now !== undefined ? { now: opts.now } : {}),
        onError: (m) =>
          void debugLog("error", "session.record-error", { sid, message: m }),
      })
    : null;

  // ── Emission: disk (via writer, coalesced deltas) + bus (raw, synchronous) ──
  // `lastSeq` mirrors the writer's assigned seq so a raw bus delta can preview
  // the seq its coalesced disk chunk will claim on flush.
  let lastSeq = meta.lastSeq;
  let deltaBuf = "";
  let deltaKind: "message" | "reasoning" | null = null;
  let deltaTurn = 0;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const appendToDisk = (input: SessionEventInput): SessionEvent => {
    const event = writer.append(input);
    lastSeq = event.seq;
    return event;
  };

  const flushDeltaBuffer = (): void => {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (deltaBuf === "" || deltaKind === null) return;
    const type = deltaKind === "message" ? "message.delta" : "reasoning.delta";
    appendToDisk({ type, text: deltaBuf, turn: deltaTurn });
    deltaBuf = "";
    deltaKind = null;
  };

  const scheduleFlush = (): void => {
    if (flushTimer !== null) return;
    flushTimer = setTimeout(flushDeltaBuffer, COALESCE_FLUSH_MS);
    flushTimer.unref?.();
  };

  /** Emit a non-delta event: flush pending deltas (order), append to disk, tap the bus. */
  const emit = (input: SessionEventInput): SessionEvent => {
    flushDeltaBuffer();
    const event = appendToDisk(input);
    onLocalEvent?.(event);
    return event;
  };

  /** Emit a text/reasoning delta: raw to the bus now; coalesced to disk. */
  const emitDelta = (
    kind: "message" | "reasoning",
    text: string,
    turn: number,
  ): void => {
    if (text === "") return;
    // Bus: raw, synchronous, previewing the coalesced disk seq.
    onLocalEvent?.({
      v: EVENT_SCHEMA_VERSION,
      sid,
      seq: lastSeq + 1,
      ts: now(),
      type: kind === "message" ? "message.delta" : "reasoning.delta",
      text,
      turn,
    });
    // Disk: coalesce. A switch between kinds flushes the other first so on-disk
    // order across kinds is preserved.
    if (deltaKind !== null && deltaKind !== kind) flushDeltaBuffer();
    deltaKind = kind;
    deltaTurn = turn;
    deltaBuf += text;
    if (deltaBuf.length >= COALESCE_MAX_CHARS) flushDeltaBuffer();
    else scheduleFlush();
  };

  /** Emit a `session.state` event and mirror the state into meta. */
  const setState = (state: SessionState, reason?: string): void => {
    emit(
      reason !== undefined
        ? { type: "session.state", state, reason }
        : { type: "session.state", state },
    );
    writer.patchMeta({ state });
  };

  // ── Cancellation plumbing ─────────────────────────────────────────────────
  // The session-level controller is aborted by an inbox `cancel` (mid-turn) or
  // SIGTERM; `buildTurnExtras` is wired to it. A per-turn controller (chained
  // to it) also carries the stall abort, so a hung turn dies WITHOUT ending the
  // session — the conversation survives (ADR-023 §7).
  const sessionController = new AbortController();
  let turnRunning = false;
  let cancelRequested = false;
  const pendingMessages: string[] = [];
  let notifyWaiter: (() => void) | null = null;

  const onSigterm = (): void => {
    cancelRequested = true;
    if (turnRunning && !sessionController.signal.aborted)
      sessionController.abort();
    notifyWaiter?.();
  };
  process.on("SIGTERM", onSigterm);

  // Inbox: opened ONCE for the whole session (the inbox is empty at create, so
  // nothing is replayed) so a `cancel` lands even mid-turn-1.
  const inboxTail: TailHandle = store.tailInbox(sid, (message) => {
    if (message.type === "cancel") {
      cancelRequested = true;
      if (turnRunning && !sessionController.signal.aborted)
        sessionController.abort();
    } else {
      pendingMessages.push(message.text);
    }
    notifyWaiter?.();
  });

  // ── Lifecycle bounds (detached workers only) ──────────────────────────────
  // A `worker`-owned session is a dispatched, unattended agent — the process
  // that must never run forever or grow memory without limit. Interactive
  // sessions have a human present and their own idle window, so they are left
  // unbounded here. Both bounds abort the SESSION controller through the same
  // graceful path as SIGTERM (terminal event → normal `finally` teardown →
  // fate), never `process.exit` mid-write. Both are env-overridable and can be
  // disabled with `off`/`0`.
  const lifecycleBounds: BoundHandle[] = [];
  if (meta.owner === "worker") {
    const abortForBound = (reason: string): void => {
      // Surface why the worker is ending, then drive the standard cancel path.
      emit({ type: "error", message: reason, fatal: false });
      cancelRequested = true;
      if (!sessionController.signal.aborted) sessionController.abort();
      notifyWaiter?.();
    };
    lifecycleBounds.push(
      startMaxLifetime({
        ms: resolveBoundMs(
          "OXAGEN_WORKER_MAX_LIFETIME_MS",
          DEFAULT_WORKER_MAX_LIFETIME_MS,
        ),
        onExpire: () =>
          abortForBound(
            `worker exceeded its max lifetime; aborting gracefully (override with OXAGEN_WORKER_MAX_LIFETIME_MS)`,
          ),
      }),
      startRssWatchdog({
        maxRssBytes: resolveBoundBytes(
          "OXAGEN_WORKER_MAX_RSS_MB",
          DEFAULT_WORKER_MAX_RSS_BYTES,
        ),
        onWarn: (rss, max) =>
          void debugLog("timeout", "session.rss-high", {
            sid,
            rssMb: Math.round(rss / 1048576),
            maxMb: Math.round(max / 1048576),
          }),
        onLimit: (rss, max) =>
          abortForBound(
            `worker RSS ${Math.round(rss / 1048576)} MB reached its ${Math.round(max / 1048576)} MB ceiling; aborting gracefully (override with OXAGEN_WORKER_MAX_RSS_MB)`,
          ),
      }),
    );
  }

  // ── Per-session memory (like one-shot, keyed session-<sid>) ───────────────
  const memoryDisabled = process.env["OXAGEN_DISABLE_MEMORY"] === "1";
  const sessionMemory: SessionMemory | null = memoryDisabled
    ? null
    : await openSessionMemory(cwd, `session-${sid}`);
  const fleetMemory: FleetMemory | null = memoryDisabled
    ? null
    : openFleetMemory(cwd);
  const serverMemory: ServerMemory | null =
    memoryDisabled || !resolveApiContext()
      ? null
      : createServerMemory({
          agentId: "coding-agent",
          executionRef: `cli:session-${sid}`,
          projectName: cwd.split("/").pop() || undefined,
        });

  // ── Engine wiring assembled ONCE (rules, hooks, MCP, tool gate) ───────────
  const ai =
    opts.ai ??
    createMeteredAi(createGatewayAgentAi({ cwd }), {
      onLog: (line) => void debugLog("timeout", line),
    });
  const settings = loadSettings({ cwd }).settings;
  const workspace = createCwdWorkspace(cwd);
  const projectContext = loadProjectContext(cwd);
  const codeGraph = createCodeGraphProvider((op, q, l) =>
    queryCodeGraph(cwd, op, q, l),
  );
  // Cross-process write guard (ADR-021 §5 / ADR-023 §7): N sessions — including
  // detached worker PROCESSES — share this one tree, so file writes serialize on
  // on-disk lease files under <cwd>/.oxagen/locks/ (TTL + fencing). Built ONCE
  // per session and handed to every turn; runTurn mints its own per-turn holder.
  const fileLock = createLocalFileLockProvider({ root: cwd });

  let extras: TurnExtras | null = null;
  // Project rules/hooks folded into what the model sees as project context;
  // computed once after `buildTurnExtras` and reused every turn.
  let enrichedContext: ReturnType<typeof loadProjectContext> = projectContext;
  let cumulativeUsage: TurnUsage = emptyTurnUsage();
  let lastSummary = "";
  let lastError = "";
  /** Highest settled turn — mirrors meta.turns, read by the failure distill. */
  let turnsSettled = 0;
  let fate: SessionFate = "done";

  // Session-open events, in the contract order (ADR-023 §runner):
  // session.start → session.state running → user message (turn 1) → run.
  emit({
    type: "session.start",
    title: meta.title,
    prompt: meta.prompt,
    cwd,
    model: meta.model,
    agent: meta.agent,
    mode: meta.mode,
    owner: meta.owner,
    pid: meta.pid,
  });
  // The record opens with the run's identity + git baseline (never throws).
  await recorder?.start({
    prompt: meta.prompt,
    model: meta.model,
    agent: meta.agent,
    cliVersion: pkg.version,
  });
  setState("running");

  try {
    extras = await buildTurnExtras({
      cwd,
      settings,
      readOnly: false,
      gatePermissions: true,
      signal: sessionController.signal,
      onBlocked: (name, reason) =>
        void debugLog("turn", "session.tool-blocked", { sid, name, reason }),
    });
    if (extras.systemAppend) {
      enrichedContext = {
        text: (projectContext?.text ?? "") + extras.systemAppend,
        sources: [
          ...(projectContext?.sources ?? []),
          "workspace rules + hooks",
        ],
      };
    }

    let history: ModelMessage[] | undefined;
    // A fork (ADR-028): seed the loop with the source session's reconstructed
    // history — exactly what the model saw entering resumeOf.turn + 1.
    if (meta.resumeOf) {
      history = await loadResumeHistory(meta.resumeOf);
    }
    let prompt = meta.prompt;
    let turn = 1;
    emit({ type: "message", role: "user", text: prompt, turn });

    for (;;) {
      const outcome = await runOneTurn({ prompt, turn, history });

      if (outcome.kind === "cancelled") {
        fate = "cancelled";
        break;
      }
      if (outcome.kind === "ok") {
        history = outcome.result.messages;
      }
      // A timeout/error already emitted its `error` event (fatal per mode).

      if (meta.mode === "once") {
        fate = outcome.kind === "ok" ? "done" : "failed";
        break;
      }

      // Conversation: idle in `waiting` for a follow-up (or cancel / idle-out).
      setState("waiting");
      const next = await waitForNext();
      if (next === "cancel") {
        fate = "cancelled";
        break;
      }
      if (next === "idle") {
        fate = "done";
        break;
      }
      prompt = pendingMessages.shift() as string;
      turn += 1;
      setState("running");
      emit({ type: "message", role: "user", text: prompt, turn });
    }
  } catch (err) {
    // An unexpected assembly/loop failure (not an in-turn error, which is caught
    // inside runOneTurn) — record it as a fatal error event and fail the session.
    fate = "failed";
    lastError = err instanceof Error ? err.message : String(err);
    void debugLog("error", "session.fatal", { sid, message: lastError });
    emit({ type: "error", message: lastError, fatal: true });
  } finally {
    inboxTail.stop();
    for (const bound of lifecycleBounds) bound.stop();
    flushDeltaBuffer();
    process.removeListener("SIGTERM", onSigterm);
    await extras?.closeMcp().catch(() => {});
    await sessionMemory?.close().catch(() => {});

    // ADR-028 §4: a failed run distills into an eval item automatically, so the
    // exact failure becomes a regression case without a human in the loop.
    if (fate === "failed" && recorder?.isRecording) {
      await autoDistillFailure();
    }
    await recorder?.flush();

    const summary =
      fate === "cancelled"
        ? "cancelled"
        : fate === "failed"
          ? lastError || lastSummary || "failed"
          : lastSummary;
    const durationMs = Math.max(0, now() - startedAt);
    emit({
      type: "session.end",
      state: fate,
      summary,
      durationMs,
      usage: cumulativeUsage,
    });
    writer.patchMeta({ state: fate, endedAt: now(), summary });
    // Best-effort: the log dir may have been pruned underneath us (`fleet clean`
    // racing an orphaned owner, or a test teardown). Finalization must never turn
    // that into an unhandled rejection — the events are already on their way.
    await writer.flush().catch((err: unknown) => {
      void debugLog("error", "session.flush-failed", {
        sid,
        message: err instanceof Error ? err.message : String(err),
      });
    });
  }

  return { state: fate };

  // ── Turn execution ────────────────────────────────────────────────────────

  async function runOneTurn(args: {
    prompt: string;
    turn: number;
    history: ModelMessage[] | undefined;
  }): Promise<TurnOutcome> {
    const { prompt, turn, history } = args;

    // Progress guard (identical to one-shot): headless has no Esc, so an
    // inactivity abort is the only backstop against a hung turn. Deferred while
    // a tool is executing; probes CI before aborting a turn watching checks. The
    // runner's controller chains to the SESSION controller, so a session cancel
    // (inbox/SIGTERM) aborts the in-flight turn too.
    const turnFiles = new Set<string>();
    const ciProbe = createCiWaitProbe(cwd);
    const runner = createTurnRunner(
      { turnInactivityMs: resolveTurnInactivityMs() },
      {
        callerSignal: sessionController.signal,
        onLog: (line) => void debugLog("timeout", line),
        stall: { probe: () => ciProbe.probe() },
      },
    );

    const priceModelHint = resolveModelId(meta.model);
    const budgetGuard = buildBudgetGuard(opts.budgetPolicy, priceModelHint);

    turnRunning = true;
    recorder?.turnStart(turn, prompt);
    try {
      const result = await runTurnImpl({
        prompt,
        workspace,
        ai,
        history,
        projectContext: enrichedContext,
        extraTools: extras?.extraTools,
        // ADR-028: the recorder wraps OUTSIDE the gate so it records what
        // actually executed (post-gate, post-backstop). Recording disabled ⇒
        // today's behavior, byte for byte.
        wrapTools: recorder
          ? (tools) =>
              recorder.wrapTools(
                extras?.wrapTools ? extras.wrapTools(tools) : tools,
              )
          : extras?.wrapTools,
        readOnly: false,
        profile,
        model: meta.model,
        budgetGuard,
        memory: createCombinedMemory(sessionMemory, fleetMemory, {
          server: serverMemory,
          recallQuery: prompt,
        }),
        codeGraph,
        fileLock,
        signal: runner.signal,
        onStage: (stage) => {
          runner.noteProgress();
          emit({
            type: "stage",
            kind: stage.kind,
            label: stage.label,
            detail: stage.detail,
          });
        },
        onText: (delta) => {
          runner.noteProgress();
          emitDelta("message", delta, turn);
        },
        onReasoning: (delta) => {
          runner.noteProgress();
          emitDelta("reasoning", delta, turn);
        },
        onToolCall: (name, input) => {
          runner.noteToolStart();
          ciProbe.noteToolCall(name, input);
          runner.noteProgress();
          emit({ type: "tool.start", name, input: stringifyToolInput(input) });
        },
        onToolEvent: ({ name, ok, durationMs }) => {
          runner.noteToolEnd();
          runner.noteProgress();
          emit({ type: "tool.end", name, ok, durationMs });
        },
        onFileChange: (diff, changedFiles) => {
          for (const f of changedFiles) turnFiles.add(f);
          emit({
            type: "diff",
            changedFiles,
            changedLines: diffChangedLines(diff),
          });
        },
        onError: (engineErr) =>
          void debugLog("error", "session.engine-nonfatal", {
            sid,
            phase: engineErr.phase,
            error: String(engineErr.error),
          }),
      });

      // Turn settled — emit the closing events + per/cumulative usage.
      const text = result.text;
      emit({ type: "message.end", text, turn });

      const priceModel = result.trace?.selectedModel ?? priceModelHint;
      const perTurn: TurnUsage = accumulateUsage(
        emptyTurnUsage(),
        priceModel,
        result.usage,
      );
      cumulativeUsage = addTurnUsage(cumulativeUsage, perTurn);
      const changedFiles =
        result.trace?.filesTouched && result.trace.filesTouched.length > 0
          ? result.trace.filesTouched
          : [...turnFiles];
      const stopReason =
        result.trace?.finalComplete === false ? "incomplete" : "complete";

      emit({
        type: "turn.end",
        turn,
        steps: result.steps,
        stopReason,
        changedFiles,
        usage: perTurn,
      });
      emit({ type: "usage", cumulative: cumulativeUsage });

      // Record side of the same settle: full history blob + this turn's fs layer.
      await recorder?.turnEnd({
        turn,
        messages: result.messages,
        changedFiles,
        steps: result.steps,
        stopReason,
        usage: perTurn,
      });

      lastSummary = text.slice(0, 280);
      turnsSettled = turn;
      writer.patchMeta({
        turns: turn,
        usage: cumulativeUsage,
        summary: lastSummary,
      });
      return { kind: "ok", result };
    } catch (err) {
      // A session cancel (inbox/SIGTERM) aborts the SESSION controller; a stall
      // aborts only the TURN controller. That distinction is the fate.
      if (sessionController.signal.aborted && cancelRequested) {
        return { kind: "cancelled" };
      }
      const timeoutReason =
        runner.signal.reason instanceof AgentTimeoutError
          ? runner.signal.reason
          : err instanceof AgentTimeoutError
            ? err
            : null;
      const message = timeoutReason
        ? timeoutReason.message
        : err instanceof Error
          ? err.message
          : String(err);
      lastError = message;
      // Fatal only in `once` mode; a conversation session survives to `waiting`.
      const fatal = meta.mode === "once";
      emit({ type: "error", message, fatal });
      void debugLog("error", "session.turn-error", {
        sid,
        turn,
        message,
        fatal,
      });
      return { kind: timeoutReason ? "timeout" : "error", message };
    } finally {
      turnRunning = false;
      runner.stop();
    }
  }

  /**
   * Await the next conversation event while `waiting`: a follow-up message, a
   * cancel, or the idle timeout. Resolves immediately when a message/cancel is
   * already queued (arrived mid-turn).
   */
  function waitForNext(): Promise<"message" | "cancel" | "idle"> {
    if (cancelRequested) return Promise.resolve("cancel");
    if (pendingMessages.length > 0) return Promise.resolve("message");
    return new Promise((resolve) => {
      let settled = false;
      const settle = (v: "message" | "cancel" | "idle"): void => {
        if (settled) return;
        settled = true;
        clearTimeout(idleTimer);
        notifyWaiter = null;
        resolve(v);
      };
      const idleTimer = setTimeout(() => settle("idle"), idleTimeoutMs);
      idleTimer.unref?.();
      notifyWaiter = () => settle(cancelRequested ? "cancel" : "message");
    });
  }

  /**
   * Seed the conversation history for a resumed session (ADR-028): read the
   * SOURCE session's replay record and reconstruct the exact `ModelMessage[]`
   * the model saw entering `resumeOf.turn + 1`. Reconstruction failure is
   * non-fatal by design — the fork proceeds from the restored tree with empty
   * history, and says so loudly on the envelope.
   */
  async function loadResumeHistory(resumeOf: {
    sid: string;
    turn: number;
  }): Promise<ModelMessage[] | undefined> {
    // The state after turn 0 is the session start — empty history by definition.
    if (resumeOf.turn === 0) return undefined;
    try {
      const sourceStore = openRecordStore(
        sessionDir(store.rootDir, resumeOf.sid),
      );
      const run = await readRun(sourceStore);
      const messages =
        run === null
          ? null
          : await reconstructHistory(sourceStore, run, resumeOf.turn);
      if (messages === null) {
        emit({
          type: "error",
          message:
            `resume: no reconstructable history for ${resumeOf.sid} turn ${resumeOf.turn} ` +
            `(no record, turn never settled, or history truncated) — starting with empty history`,
          fatal: false,
        });
        return undefined;
      }
      // reconstructHistory returns unknown[]; the recorded value IS the
      // ModelMessage[] runTurn produced — the cast restores the erased type.
      return messages as ModelMessage[];
    } catch (err) {
      emit({
        type: "error",
        message:
          `resume: failed reading the record of ${resumeOf.sid}: ` +
          `${err instanceof Error ? err.message : String(err)} — starting with empty history`,
        fatal: false,
      });
      return undefined;
    }
  }

  /**
   * Failure→eval distillation (ADR-028 §4), best-effort by contract: any error
   * here is debug-logged and dropped — finalizing a failed session must never
   * crash on its own post-mortem.
   */
  async function autoDistillFailure(): Promise<void> {
    try {
      // Settle the recorder's queued appends first so the seq seed below reads
      // a complete log (one live writer at a time keeps seqs contiguous).
      await recorder?.flush();
      const records = await recordStore.readRecords();
      const item = distillEvalItem({
        sid,
        prompt: meta.prompt,
        reason: "failed",
        fate,
        model: meta.model,
        agent: meta.agent,
        turns: turnsSettled,
        errorMessage: lastError || undefined,
        changedFiles: [],
        distilledAt: now(),
      });
      const blob = await recordStore.putJsonBlob(item);
      const distillWriter = recordStore.openWriter({
        sid,
        // Count normally equals the last seq; max() guards a torn tail line.
        lastSeq: Math.max(
          records.length,
          records[records.length - 1]?.seq ?? 0,
        ),
        ...(opts.now !== undefined ? { now: opts.now } : {}),
      });
      distillWriter.append({
        t: "distill",
        reason: "failed",
        itemRef: blob.ref,
        isPushed: false,
      });
      await distillWriter.flush();
      // A human-readable copy next to the log: `cat …/record/distilled.json`.
      await writeFile(
        join(recordStore.rootDir, "distilled.json"),
        JSON.stringify(item, null, 2) + "\n",
      );
    } catch (err) {
      void debugLog("error", "session.distill-failed", {
        sid,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Build the per-turn budget guard for a headless session: no interactive
   * approver, so `prompt` mode degrades to a hard stop (`onPause → false`), and
   * grace/stop surface as NON-fatal `error` events instead of stderr writes
   * (one-shot's headless degrade, ADR-023 §7).
   */
  function buildBudgetGuard(
    policy: TurnBudgetPolicy | undefined,
    model: string,
  ): ReturnType<typeof createTurnBudgetGuard> {
    if (!policy) return undefined;
    let graceWarned = false;
    return createTurnBudgetGuard(policy, model, {
      onWithinGrace: (verdict: TurnBudgetVerdict) => {
        if (graceWarned) return;
        graceWarned = true;
        emit({
          type: "error",
          message:
            `Over budget — within grace window (${formatBudgetUsd(verdict.costUsd)} / ` +
            `ceiling ${formatBudgetUsd(verdict.ceilingUsd)}).`,
          fatal: false,
        });
      },
      onPause: () => false,
      onStop: (verdict: TurnBudgetVerdict) => {
        const modeLabel = TURN_BUDGET_MODES[verdict.mode].label;
        emit({
          type: "error",
          message:
            `Per-turn budget reached — stopped at ${formatBudgetUsd(verdict.costUsd)} of ` +
            `${formatBudgetUsd(verdict.limitUsd)} (${modeLabel}).`,
          fatal: false,
        });
      },
    });
  }
}

/** JSON-stringify a tool input for the wire, capped at 2 KB, tolerant of cycles. */
function stringifyToolInput(input: unknown): string {
  try {
    const json = JSON.stringify(input);
    return capForWire(json ?? String(input));
  } catch {
    return capForWire(String(input));
  }
}
