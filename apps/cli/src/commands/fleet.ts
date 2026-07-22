/**
 * `oxagen fleet` — the session fleet command tree (ADR-023, spec §3).
 *
 * A session is an append-only event log on disk; every surface — the Mission
 * Control TUI, a `--json` pipe, a second terminal — is a renderer of the same
 * stream. This module is the headless surface of that idea: one writer-
 * parameterized handler per verb, each routing its output through the universal
 * {@link createOutput} layer so stdout stays machine-clean (envelope NDJSON or a
 * JSON result) and all chrome goes to stderr.
 *
 *   fleet dispatch [prompt…]   detached worker; prints sid then exits 0
 *   fleet ls                   roster from meta.json snapshots (--json → array)
 *   fleet watch [sid…]         merged live stream; no sids = all active
 *   fleet attach <sid>         TUI focused on sid; else NDJSON replay + follow
 *   fleet send <sid> <msg…>    append a follow-up to the inbox ("-" → stdin)
 *   fleet cancel <sid>|--all   inbox cancel (+ SIGTERM an alive worker owner)
 *   fleet logs <sid>           replay events.ndjson (--from-seq, --follow)
 *   fleet clean                prune terminal sessions (--older-than, --all)
 *   fleet worker <sid>         [hidden] the detached worker entry point
 *
 * The interactive REPL's `/dispatch` mode (docs/specs/repl-async-dispatch.md)
 * is a front-end for the same primitive: mode ON routes plain prompts through
 * `dispatchDetachedSession` exactly like `fleet dispatch`, then tails the
 * session store to fold completions back into the transcript.
 *
 * Time travel (ADR-028) — read the session's sidecar record (`record/`):
 *
 *   fleet replay <sid>         inspect the recorded run (--turn N for full I/O, --verify)
 *   fleet bisect <sid> --cmd   restore-and-probe binary search for the first bad turn
 *   fleet resume <sid> --turn  fork a new session from the state after turn N
 *   fleet feedback <sid> up|down   append a human verdict (down auto-distills)
 *   fleet distill <sid>        run → evals-v1 dataset item (--push to the platform)
 *
 * Design notes:
 * - Handlers take a trailing {@link CommandWriter} (default the real stdout) so
 *   they compose with the REPL's inline capture seam exactly like `models.ts`.
 *   The TUI-launching entries (root, attach) refuse to open Ink when handed a
 *   non-stdout writer — they print a one-line "open a full terminal" hint.
 * - Streaming verbs keep the process alive with a ref'd heartbeat (the store's
 *   tail timers are unref'd) and stop on SIGINT/SIGTERM, an injected
 *   `AbortSignal` (tests), or — for `--follow`/attach — the session's own
 *   `session.end`, exiting with its fate.
 * - `requireSession` gates the two verbs that actually run the engine
 *   (`dispatch`, `worker`); everything else reads/controls the store and needs
 *   no account. The heavy engine (`runner.js`) is imported lazily inside the
 *   worker only, so `fleet ls` never pays the agent-engine cold start.
 */
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DISTILL_DATASET_SLUG,
  bisectTurns,
  distillEvalItem,
  isTruncatedBlob,
  openRecordStore,
  readRun,
  removeWorktree,
  restoreFsAtTurn,
  verifyRun,
  type DistillReason,
  type DistilledEvalItem,
  type ExecPort,
  type RecordStore,
  type RecordWriter,
  type ReplayRecord,
  type ReplayRun,
} from "@oxagen/replay";
import { createOutput, type Output } from "../lib/output.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";
import {
  apiGetOrThrow,
  apiPostOrThrow,
  resolveApiContext,
} from "../lib/api.js";
import {
  isActiveState,
  openFleetStore,
  type SessionMeta,
  type SessionMetaView,
  type SessionStore,
  type TailHandle,
} from "../sessions/store.js";
import { fleetRoot, sessionDir } from "../sessions/paths.js";
import { resolveSidRef, shortSid } from "../sessions/ids.js";
import type { SessionEvent } from "../sessions/events.js";
import {
  dispatchDetachedSession,
  type DispatchDetachedOptions,
} from "../sessions/dispatch.js";
import { toAggregateLine } from "../tui/mission-control/aggregate-line.js";
// Type-only (erased at compile) so the heavy engine graph behind runner.js is
// never loaded to type the worker's injectable — the runtime import is lazy.
import type { runSession as RunSession } from "../sessions/runner.js";

/** A running/waiting session count above which detached dispatch warns. */
const ALIVE_WARN_THRESHOLD = 8;
/** Ref'd heartbeat period for streaming verbs (< 2^31-1 to avoid setInterval clamping). */
const KEEPALIVE_MS = 2_000_000_000;
/** The session fate returned by a follow/attach stream once `session.end` lands. */
type SessionFate = "done" | "failed" | "cancelled";

// ── shared option shapes ─────────────────────────────────────────────────────

/** Options common to every verb (mode selection + testing seams). */
interface CommonOptions {
  json?: boolean;
  quiet?: boolean;
  /** Working directory whose fleet is targeted; defaults to `process.cwd()`. */
  cwd?: string;
}

/** Line rendering knobs for the streaming verbs' pretty (non-json) output. */
interface StreamRenderOptions {
  verbose?: boolean;
  /** Prefix each aggregate line with a short-sid gutter (multi-session views). */
  gutter?: boolean;
  /** Render assistant `message.delta` text inline (single-session follow). */
  showDeltas?: boolean;
}

// ── small shared helpers ─────────────────────────────────────────────────────

/** Open the session store for the fleet rooted at `cwd`. */
function openStore(cwd?: string): SessionStore {
  return openFleetStore(fleetRoot(cwd ?? process.cwd()));
}

/** Whitespace-collapse and clip a string to `max` chars with an ellipsis. */
function clip(value: string, max: number): string {
  const one = value.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : one.slice(0, max - 1) + "…";
}

/** True when stdout is a real interactive terminal (overridable for tests). */
function stdoutIsTty(override?: boolean): boolean {
  return override ?? process.stdout.isTTY === true;
}

/** Read all of stdin to a trimmed string (piped-prompt / piped-message paths). */
function readStdin(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      data += chunk;
    });
    process.stdin.once("end", () => resolve(data.trim()));
    process.stdin.once("error", reject);
  });
}

/**
 * Emit one event to the active surface: json → the raw envelope as an NDJSON
 * line; pretty → its aggregate-timeline line (with an optional short-sid gutter),
 * or the raw delta text when a single-session follow wants the assistant stream.
 */
function emitEvent(
  out: Output,
  writer: CommandWriter,
  event: SessionEvent,
  render: StreamRenderOptions = {},
): void {
  if (out.isJson) {
    out.event(event);
    return;
  }
  if (render.showDeltas && event.type === "message.delta") {
    if (event.text !== "") writer.write(event.text);
    return;
  }
  const line = toAggregateLine(event, { verbose: render.verbose });
  if (!line) return;
  writer.write(
    render.gutter ? `${shortSid(line.sid).padEnd(6)} ${line.text}` : line.text,
  );
}

/**
 * Keep the process alive and streaming until an interrupt: a real SIGINT/SIGTERM
 * or an injected `AbortSignal` (tests). The heartbeat is what holds the event
 * loop open — the store's tail timers are all unref'd.
 */
function waitForStop(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const keepAlive = setInterval(() => {}, KEEPALIVE_MS);
    const stop = (): void => {
      clearInterval(keepAlive);
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      signal?.removeEventListener("abort", stop);
      resolve();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    signal?.addEventListener("abort", stop, { once: true });
  });
}

/**
 * Tail one session from `fromSeq`, rendering every event, and resolve with its
 * fate the moment `session.end` arrives — or `null` if interrupted first. The
 * follow exit contract for `dispatch --follow` and `attach --json`.
 */
function followUntilEnd(
  store: SessionStore,
  sid: string,
  fromSeq: number,
  out: Output,
  writer: CommandWriter,
  render: StreamRenderOptions,
  signal?: AbortSignal,
): Promise<SessionFate | null> {
  return new Promise<SessionFate | null>((resolve) => {
    let settled = false;
    const keepAlive = setInterval(() => {}, KEEPALIVE_MS);
    let tail: TailHandle | null = null;
    const finish = (fate: SessionFate | null): void => {
      if (settled) return;
      settled = true;
      clearInterval(keepAlive);
      tail?.stop();
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      signal?.removeEventListener("abort", onSignal);
      resolve(fate);
    };
    const onSignal = (): void => finish(null);
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    if (signal) {
      if (signal.aborted) return finish(null);
      signal.addEventListener("abort", onSignal, { once: true });
    }
    tail = store.tailEvents(
      sid,
      (event) => {
        emitEvent(out, writer, event, render);
        if (event.type === "session.end") finish(event.state);
      },
      { fromSeq },
    );
  });
}

/** Map a follow/attach fate onto the process exit code (0 done · 1 failed/cancelled · 130 interrupted). */
function applyFateExit(fate: SessionFate | null): void {
  if (fate === "done") return;
  if (fate === "failed" || fate === "cancelled") {
    if (!process.exitCode) process.exitCode = 1;
  } else if (!process.exitCode) {
    process.exitCode = 130;
  }
}

// ── ls ───────────────────────────────────────────────────────────────────────

const STATE_GLYPH: Record<SessionMetaView["derivedState"], string> = {
  queued: "○",
  running: "●",
  waiting: "◇",
  done: "✓",
  failed: "✗",
  cancelled: "◼",
  orphaned: "⚠",
};

/** A compact "N{unit} ago" relative time for rosters. */
function relTime(ts: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Render the roster as an aligned human-readable table. */
function renderLsTable(
  sessions: SessionMetaView[],
  now: number = Date.now(),
): string {
  if (sessions.length === 0) {
    return 'No sessions in this fleet. Start one with `oxagen fleet dispatch "…"`.';
  }
  const rows = sessions.map((s) => ({
    sid: shortSid(s.sid),
    state: `${STATE_GLYPH[s.derivedState]} ${s.derivedState}`,
    title: clip(s.title, 44),
    turns: `${s.turns}t`,
    cost: `$${s.usage.costUsd.toFixed(2)}`,
    updated: relTime(s.updatedAt, now),
  }));
  const width = (pick: (r: (typeof rows)[number]) => string): number =>
    rows.reduce((max, r) => Math.max(max, pick(r).length), 0);
  const wSid = width((r) => r.sid);
  const wState = width((r) => r.state);
  const wTitle = width((r) => r.title);
  const wTurns = width((r) => r.turns);
  const wCost = width((r) => r.cost);
  return rows
    .map(
      (r) =>
        `${r.sid.padEnd(wSid)}  ${r.state.padEnd(wState)}  ${r.title.padEnd(wTitle)}  ` +
        `${r.turns.padStart(wTurns)}  ${r.cost.padStart(wCost)}  ${r.updated}`,
    )
    .join("\n");
}

/** `oxagen fleet ls` — the roster from every session's meta.json snapshot. */
export async function handleFleetLs(
  opts: CommonOptions = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json, quiet: opts.quiet }, writer);
  const sessions = await openStore(opts.cwd).listSessions();
  // json → the SessionMetaView array (as consumed by `fleet ls --json | jq …`);
  // pretty → the aligned table. One call keeps the shapes in lockstep.
  out.data(sessions, () => renderLsTable(sessions));
}

// ── dispatch ─────────────────────────────────────────────────────────────────

export interface FleetDispatchOptions extends CommonOptions {
  model?: string;
  agent?: string;
  /** End after the first turn instead of staying open for follow-ups. */
  once?: boolean;
  /** Stream the session's events to completion and exit with its fate. */
  follow?: boolean;
  verbose?: boolean;
  /** Injectable spawner (tests assert the worker contract without forking). */
  spawnImpl?: DispatchDetachedOptions["spawnImpl"];
  /** Injectable store (tests point at a tmp fleet dir via OXAGEN_FLEET_DIR too). */
  store?: SessionStore;
  /** Injectable stdin reader (piped-prompt tests). */
  readStdin?: () => Promise<string>;
  /** Injected abort for the `--follow` stream (tests). */
  signal?: AbortSignal;
}

/**
 * `oxagen fleet dispatch [prompt…]` — create a session and launch its detached
 * worker. Prints the sid and exits 0; with `--follow`, streams the session to
 * its fate. An empty or `-` prompt with piped stdin reads the prompt from stdin.
 */
export async function handleFleetDispatch(
  promptWords: string[],
  opts: FleetDispatchOptions = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json, quiet: opts.quiet }, writer);
  const cwd = opts.cwd ?? process.cwd();

  let prompt = promptWords.join(" ").trim();
  if ((prompt === "" || prompt === "-") && !process.stdin.isTTY) {
    prompt = (
      opts.readStdin ? await opts.readStdin() : await readStdin()
    ).trim();
  }
  if (prompt === "" || prompt === "-") {
    out.error(
      'dispatch needs a prompt (arguments, or piped stdin with "-").',
      "usage",
    );
    process.exitCode = 2;
    return;
  }

  const store = opts.store ?? openStore(cwd);

  // Soft cap: detached workers are bounded by the OS, not fleet.concurrency —
  // warn (stderr) when the fleet is already busy so a runaway loop is visible.
  const aliveBefore = (await store.listSessions()).filter((s) =>
    isActiveState(s.derivedState),
  ).length;
  if (aliveBefore >= ALIVE_WARN_THRESHOLD) {
    out.warn(
      `${aliveBefore} sessions already alive — detached workers are not capped by fleet.concurrency.`,
    );
  }

  const { sid, title } = await dispatchDetachedSession({
    cwd,
    prompt,
    mode: opts.once ? "once" : "conversation",
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
    store,
    ...(opts.spawnImpl !== undefined ? { spawnImpl: opts.spawnImpl } : {}),
  });

  if (!opts.follow) {
    out.data({ sid, title }, () => `dispatched ${sid} — oxagen fleet to watch`);
    return;
  }

  // --follow: stream the just-spawned worker's log from the start; exit its fate.
  const followOut = createOutput(
    { json: opts.json, quiet: opts.quiet, autoJson: true },
    writer,
  );
  const fate = await followUntilEnd(
    store,
    sid,
    1,
    followOut,
    writer,
    { verbose: opts.verbose, showDeltas: true },
    opts.signal,
  );
  applyFateExit(fate);
}

// ── watch ────────────────────────────────────────────────────────────────────

export interface FleetWatchOptions extends CommonOptions {
  verbose?: boolean;
  /** Injected abort to stop the stream (tests / a caller other than a signal). */
  signal?: AbortSignal;
}

/**
 * `oxagen fleet watch [sid…]` — merge many sessions' live event streams onto one
 * output. Explicit sids replay from the beginning and follow; with no sids, every
 * currently-active session is tailed from its current end and any session that
 * becomes active while watching is adopted automatically.
 */
export async function handleFleetWatch(
  sids: string[] = [],
  opts: FleetWatchOptions = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput(
    { json: opts.json, quiet: opts.quiet, autoJson: true },
    writer,
  );
  const store = openStore(opts.cwd);
  const render: StreamRenderOptions = { verbose: opts.verbose, gutter: true };

  const tails = new Map<string, TailHandle>();
  const lastSeen = new Map<string, number>();
  const emit = (event: SessionEvent): void => {
    const seen = lastSeen.get(event.sid) ?? 0;
    if (event.seq <= seen) return; // dedupe across a re-adopt
    lastSeen.set(event.sid, event.seq);
    emitEvent(out, writer, event, render);
  };
  const adopt = (sid: string, fromSeq: number): void => {
    if (tails.has(sid)) return;
    tails.set(sid, store.tailEvents(sid, emit, { fromSeq }));
  };

  let rosterWatch: TailHandle | null = null;
  if (sids.length > 0) {
    // Explicit sids: full replay + follow (a consumer pointed at a session wants
    // its whole log, even a terminal one).
    const known = (await store.listSessions()).map((s) => s.sid);
    for (const ref of sids) {
      const sid = resolveSidRef(ref, known);
      if (!sid) out.warn(`no session matching "${ref}"`);
      else adopt(sid, 1);
    }
    if (tails.size === 0) {
      out.error("no matching sessions to watch.");
      return;
    }
  } else {
    // No sids: adopt every active session from its current end, and any that
    // become active while watching. Roster changes drive adoption (≤1 s).
    rosterWatch = store.watchSessions(
      (sessions) => {
        for (const s of sessions) {
          if (isActiveState(s.derivedState)) {
            adopt(s.sid, (lastSeen.get(s.sid) ?? s.lastSeq) + 1);
          }
        }
      },
      opts.signal ? { signal: opts.signal } : {},
    );
  }

  await waitForStop(opts.signal);
  rosterWatch?.stop();
  for (const tail of tails.values()) tail.stop();
}

// ── attach ───────────────────────────────────────────────────────────────────

export interface FleetAttachOptions extends CommonOptions {
  verbose?: boolean;
  /** Override stdout TTY detection (tests). */
  stdoutIsTTY?: boolean;
  signal?: AbortSignal;
}

/**
 * `oxagen fleet attach <sid>` — focus a single session. In a real terminal it
 * opens Mission Control on that session; piped or `--json` it replays the whole
 * log from the start and follows live, exiting with the session's fate. (The
 * Mission Control launch lands with the TUI on this branch.)
 */
export async function handleFleetAttach(
  sidRef: string,
  opts: FleetAttachOptions = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput(
    {
      json: opts.json,
      quiet: opts.quiet,
      autoJson: true,
      // One TTY truth: the injected override must steer autoJson AND the
      // interactive branch below, or a test/caller can land in a mode split.
      ...(opts.stdoutIsTTY !== undefined
        ? { stdoutIsTTY: opts.stdoutIsTTY }
        : {}),
    },
    writer,
  );
  const store = openStore(opts.cwd);
  const resolved = resolveSidRef(
    sidRef,
    (await store.listSessions()).map((s) => s.sid),
  );
  if (!resolved) {
    out.error(`no session matching "${sidRef}"`);
    return;
  }

  if (out.isJson) {
    const fate = await followUntilEnd(
      store,
      resolved,
      1,
      out,
      writer,
      { verbose: opts.verbose, showDeltas: true },
      opts.signal,
    );
    applyFateExit(fate);
    return;
  }

  // Pretty mode wants a full terminal for the focused TUI.
  if (writer !== stdoutWriter) {
    out.info(
      `open a full terminal and run: oxagen fleet attach ${shortSid(resolved)}`,
    );
    return;
  }
  if (!stdoutIsTty(opts.stdoutIsTTY)) {
    // Non-TTY pretty (rare): degrade to a headless replay + follow.
    const fate = await followUntilEnd(
      store,
      resolved,
      1,
      out,
      writer,
      { verbose: opts.verbose, showDeltas: true },
      opts.signal,
    );
    applyFateExit(fate);
    return;
  }
  await launchMissionControlFor(opts.cwd, resolved);
}

// ── send ─────────────────────────────────────────────────────────────────────

export interface FleetSendOptions extends CommonOptions {
  readStdin?: () => Promise<string>;
}

/**
 * `oxagen fleet send <sid> <message…>` — append a follow-up turn to a session's
 * inbox; the owning process threads it as the next turn. `-` reads the message
 * from stdin. Fails when the session has already ended.
 */
export async function handleFleetSend(
  sidRef: string,
  messageWords: string[],
  opts: FleetSendOptions = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json, quiet: opts.quiet }, writer);
  const store = openStore(opts.cwd);
  const sessions = await store.listSessions();
  const resolved = resolveSidRef(
    sidRef,
    sessions.map((s) => s.sid),
  );
  const meta = resolved ? sessions.find((s) => s.sid === resolved) : undefined;
  if (!meta) {
    out.error(`no session matching "${sidRef}"`);
    return;
  }
  if (!isActiveState(meta.derivedState)) {
    out.error(
      `session ${shortSid(meta.sid)} is ${meta.derivedState}; cannot send to it.`,
    );
    return;
  }

  let text = messageWords.join(" ").trim();
  if (text === "" || text === "-") {
    if (opts.readStdin) text = (await opts.readStdin()).trim();
    else if (!process.stdin.isTTY) text = (await readStdin()).trim();
  }
  if (text === "" || text === "-") {
    out.error("send needs a message (arguments, or piped stdin).", "usage");
    process.exitCode = 2;
    return;
  }

  await store.appendInbox(meta.sid, { type: "message", text, ts: Date.now() });
  out.data(
    { sid: meta.sid, ok: true },
    () => `→ sent to ${shortSid(meta.sid)}`,
  );
}

// ── cancel ───────────────────────────────────────────────────────────────────

export interface FleetCancelOptions extends CommonOptions {
  all?: boolean;
  /** Injectable signaller (tests must not SIGTERM a live pid = the runner). */
  killImpl?: (pid: number, signal: NodeJS.Signals) => void;
}

interface CancelResult {
  sid: string;
  cancelled: boolean;
  signalled: boolean;
  reason?: string;
}

/**
 * `oxagen fleet cancel <sid>|--all` — append a `cancel` to the matching active
 * sessions' inboxes, and SIGTERM an owner worker that is still alive so a wedged
 * worker actually dies. Terminal sessions are reported, not touched.
 */
export async function handleFleetCancel(
  sidRef: string | undefined,
  opts: FleetCancelOptions = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json, quiet: opts.quiet }, writer);
  const store = openStore(opts.cwd);
  const sessions = await store.listSessions();
  const kill =
    opts.killImpl ??
    ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));

  let targets: SessionMetaView[];
  if (opts.all) {
    targets = sessions.filter((s) => isActiveState(s.derivedState));
  } else {
    if (!sidRef) {
      out.error("cancel needs a <sid> or --all.", "usage");
      process.exitCode = 2;
      return;
    }
    const resolved = resolveSidRef(
      sidRef,
      sessions.map((s) => s.sid),
    );
    const meta = resolved
      ? sessions.find((s) => s.sid === resolved)
      : undefined;
    if (!meta) {
      out.error(`no session matching "${sidRef}"`);
      return;
    }
    targets = [meta];
  }

  const results: CancelResult[] = [];
  for (const s of targets) {
    if (!isActiveState(s.derivedState)) {
      results.push({
        sid: s.sid,
        cancelled: false,
        signalled: false,
        reason: `already ${s.derivedState}`,
      });
      continue;
    }
    await store.appendInbox(s.sid, { type: "cancel", ts: Date.now() });
    let signalled = false;
    if (s.owner === "worker" && s.alive && s.pid > 0) {
      try {
        kill(s.pid, "SIGTERM");
        signalled = true;
      } catch {
        // Owner already gone or not ours — the inbox cancel still stands.
      }
    }
    results.push({ sid: s.sid, cancelled: true, signalled });
  }

  if (out.isJson) {
    out.data(results);
    return;
  }
  if (results.length === 0) {
    out.info("no active sessions to cancel.");
    return;
  }
  for (const r of results) {
    writer.write(
      r.cancelled
        ? `◼ cancelled ${shortSid(r.sid)}${r.signalled ? " (signalled worker)" : ""}`
        : `· ${shortSid(r.sid)} — ${r.reason}`,
    );
  }
}

// ── logs ─────────────────────────────────────────────────────────────────────

export interface FleetLogsOptions extends CommonOptions {
  /** Resume the replay at this sequence number (string from the flag). */
  fromSeq?: string;
  /** Keep tailing after the replay. */
  follow?: boolean;
  verbose?: boolean;
  signal?: AbortSignal;
}

/**
 * `oxagen fleet logs <sid>` — replay a session's events.ndjson. json → the raw
 * envelope, one line each; pretty → verbose aggregate lines (everything shows).
 * `--from-seq N` resumes at a sequence; `--follow` keeps tailing live.
 */
export async function handleFleetLogs(
  sidRef: string,
  opts: FleetLogsOptions = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput(
    { json: opts.json, quiet: opts.quiet, autoJson: true },
    writer,
  );
  const store = openStore(opts.cwd);
  const resolved = resolveSidRef(
    sidRef,
    (await store.listSessions()).map((s) => s.sid),
  );
  if (!resolved) {
    out.error(`no session matching "${sidRef}"`);
    return;
  }

  let fromSeq = 1;
  if (opts.fromSeq !== undefined) {
    const parsed = Number.parseInt(opts.fromSeq, 10);
    if (!Number.isInteger(parsed) || parsed < 1) {
      out.error(
        `invalid --from-seq "${opts.fromSeq}". Use a positive integer.`,
        "usage",
      );
      process.exitCode = 2;
      return;
    }
    fromSeq = parsed;
  }

  const render: StreamRenderOptions = { verbose: true, gutter: false };
  if (!opts.follow) {
    for (const event of await store.readEvents(resolved, { fromSeq })) {
      emitEvent(out, writer, event, render);
    }
    return;
  }
  // --follow: tailEvents replays from fromSeq, then streams live; hold open.
  const tail = store.tailEvents(
    resolved,
    (event) => emitEvent(out, writer, event, render),
    {
      fromSeq,
    },
  );
  await waitForStop(opts.signal);
  tail.stop();
}

// ── clean ────────────────────────────────────────────────────────────────────

export interface FleetCleanOptions extends CommonOptions {
  /** Age cutoff: bare days ("7") or a duration ("1d", "12h", "30m"). */
  olderThan?: string;
  all?: boolean;
}

/** Parse an `--older-than` value into milliseconds: `<n>` = days, `<n>[dhm]` = duration. */
function parseOlderThan(raw: string): number | null {
  const m = /^(\d+)\s*([dhm]?)$/i.exec(raw.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] || "d").toLowerCase();
  const mult = unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : 86_400_000;
  return n * mult;
}

/**
 * `oxagen fleet clean` — prune terminal (or orphaned) sessions idle past the
 * cutoff. Live sessions are never removed. `--all` ignores the age cutoff.
 */
export async function handleFleetClean(
  opts: FleetCleanOptions = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json, quiet: opts.quiet }, writer);
  let olderThanMs = 7 * 86_400_000;
  if (opts.olderThan !== undefined) {
    const parsed = parseOlderThan(opts.olderThan);
    if (parsed === null) {
      out.error(
        `invalid --older-than "${opts.olderThan}". Use days (e.g. 7) or a duration (e.g. 1d, 12h).`,
        "usage",
      );
      process.exitCode = 2;
      return;
    }
    olderThanMs = parsed;
  }

  const { removed } = await openStore(opts.cwd).clean({
    olderThanMs,
    all: opts.all,
  });
  out.data({ removed, count: removed.length }, () =>
    removed.length === 0
      ? "Nothing to prune."
      : `Pruned ${removed.length} session(s): ${removed.map(shortSid).join(", ")}`,
  );
}

// ── time travel: replay / bisect / resume / feedback / distill (ADR-028) ─────

/** States a session must be in before post-hoc verdicts/distills make sense. */
const TERMINAL_STATES: ReadonlySet<string> = new Set([
  "done",
  "failed",
  "cancelled",
]);

/** Real exec port for git worktree restore ops (tests inject a fake). */
const realExec: ExecPort = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd: opts.cwd, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        const code = err
          ? (((err as { code?: unknown }).code as number | undefined) ?? 1)
          : 0;
        resolve({
          stdout: stdout ?? "",
          code: typeof code === "number" ? code : 1,
        });
      },
    );
  });

/** Run a predicate command via `sh -c` in `cwd`; resolves its exit code (127 = spawn failure). */
function runShell(cmd: string, cwd: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", cmd], { cwd, stdio: "ignore" });
    child.once("error", () => resolve(127));
    child.once("close", (code) => resolve(code ?? 1));
  });
}

/** A short random suffix for scratch worktree names (collision-proof enough). */
function scratchSuffix(): string {
  return randomBytes(3).toString("hex");
}

/**
 * Resolve a sid reference and load its recorded run, with the uniform error
 * contract of the other verbs. Returns null after reporting when the session
 * is unknown or has no ADR-028 record (recording off / pre-ADR-028 session).
 */
async function openRecordedRun(
  store: SessionStore,
  sidRef: string,
  out: Output,
): Promise<{
  sid: string;
  meta: SessionMetaView;
  recordStore: RecordStore;
  run: ReplayRun;
} | null> {
  const sessions = await store.listSessions();
  const sid = resolveSidRef(
    sidRef,
    sessions.map((s) => s.sid),
  );
  const meta = sid ? sessions.find((s) => s.sid === sid) : undefined;
  if (!sid || !meta) {
    out.error(`no session matching "${sidRef}"`);
    return null;
  }
  const recordStore = openRecordStore(sessionDir(store.rootDir, sid));
  const run = await readRun(recordStore);
  if (!run) {
    out.error(
      `session ${shortSid(sid)} has no replay record — recording was off (OXAGEN_FLEET_RECORD=0) ` +
        `or the session predates ADR-028.`,
      "no_record",
    );
    return null;
  }
  return { sid, meta, recordStore, run };
}

/**
 * Open a record writer seeded PAST the existing log for post-hoc appends
 * (feedback, distill). The count normally equals the last seq; `max()` guards
 * a torn tail line so a new append can never collide with an existing seq.
 */
function openPostHocWriter(
  recordStore: RecordStore,
  sid: string,
  records: ReplayRecord[],
): RecordWriter {
  return recordStore.openWriter({
    sid,
    lastSeq: Math.max(records.length, records[records.length - 1]?.seq ?? 0),
  });
}

/** Parse a `--turn`-style integer flag; null when not a valid integer ≥ `min`. */
function parseTurnFlag(raw: string, min: number): number | null {
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= min ? parsed : null;
}

// ── replay ───────────────────────────────────────────────────────────────────

/** One tool call in the replay view; input/output only present for the focused turn. */
export interface ReplayToolCallView {
  idx: number;
  name: string;
  ok: boolean;
  durationMs: number;
  input?: unknown;
  output?: unknown;
}

export interface ReplayTurnView {
  turn: number;
  prompt: string;
  settled: boolean;
  steps?: number;
  stopReason?: string;
  changedFiles: string[];
  usage?: { inputTokens: number; outputTokens: number; costUsd: number };
  toolCalls: ReplayToolCallView[];
}

export interface ReplayRunView {
  sid: string;
  model?: string;
  agent?: string;
  cliVersion?: string;
  gitHead?: string;
  cwd?: string;
  prompt?: string;
  lastSettledTurn: number;
  turns: ReplayTurnView[];
  feedback: Array<{ verdict: "up" | "down"; comment?: string }>;
  distills: Array<{
    reason: DistillReason;
    isPushed: boolean;
    datasetSlug?: string;
  }>;
}

/** Decode a payload blob for display: parsed JSON, a truncation note, or the raw string. */
async function blobForDisplay(
  recordStore: RecordStore,
  ref: string,
): Promise<unknown> {
  const raw = await recordStore.getBlob(ref);
  if (raw === null) return { missing: true, ref };
  try {
    const value: unknown = JSON.parse(raw);
    if (isTruncatedBlob(value)) {
      return {
        truncated: true,
        bytes: value.bytes,
        sha256: value.sha256,
        head: value.head,
      };
    }
    return value;
  } catch {
    return raw;
  }
}

/**
 * Merge a recorded run into the serializable time-travel view. `focusTurn`
 * additionally resolves that turn's FULL tool input/output payloads from the
 * blob store (every other turn stays a summary — the log can be large).
 */
export async function buildReplayView(
  recordStore: RecordStore,
  run: ReplayRun,
  focusTurn?: number,
): Promise<ReplayRunView> {
  const turns: ReplayTurnView[] = [];
  for (const turn of run.turns) {
    const toolCalls: ReplayToolCallView[] = [];
    for (const call of turn.toolCalls) {
      const view: ReplayToolCallView = {
        idx: call.idx,
        name: call.name,
        ok: call.ok,
        durationMs: call.durationMs,
      };
      if (focusTurn === turn.turn) {
        view.input = await blobForDisplay(recordStore, call.inputRef);
        view.output = await blobForDisplay(recordStore, call.outputRef);
      }
      toolCalls.push(view);
    }
    turns.push({
      turn: turn.turn,
      prompt: turn.prompt,
      settled: turn.end !== undefined,
      ...(turn.end !== undefined ? { steps: turn.end.steps } : {}),
      ...(turn.end?.stopReason !== undefined
        ? { stopReason: turn.end.stopReason }
        : {}),
      changedFiles: turn.end?.changedFiles ?? [],
      ...(turn.end !== undefined ? { usage: turn.end.usage } : {}),
      toolCalls,
    });
  }
  return {
    sid: run.sid,
    ...(run.meta?.model !== undefined ? { model: run.meta.model } : {}),
    ...(run.meta?.agent !== undefined ? { agent: run.meta.agent } : {}),
    ...(run.meta?.cliVersion !== undefined
      ? { cliVersion: run.meta.cliVersion }
      : {}),
    ...(run.meta?.gitHead !== undefined ? { gitHead: run.meta.gitHead } : {}),
    ...(run.meta !== null
      ? { cwd: run.meta.cwd, prompt: run.meta.prompt }
      : {}),
    lastSettledTurn: run.lastSettledTurn,
    turns,
    feedback: run.feedback.map((f) => ({
      verdict: f.verdict,
      ...(f.comment !== undefined ? { comment: f.comment } : {}),
    })),
    distills: run.distills.map((d) => ({
      reason: d.reason,
      isPushed: d.isPushed,
      ...(d.datasetSlug !== undefined ? { datasetSlug: d.datasetSlug } : {}),
    })),
  };
}

/** Indent a pretty-printed JSON payload under its label line. */
function indentPayload(value: unknown, pad: string): string {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return text
    .split("\n")
    .map((line) => pad + line)
    .join("\n");
}

/** Render the time-travel view for humans (json mode emits the view itself). */
export function renderReplayView(
  view: ReplayRunView,
  focusTurn?: number,
): string {
  const lines: string[] = [];
  const settled = `${view.lastSettledTurn} settled turn(s)`;
  lines.push(
    `run ${view.sid} — ${settled}${view.model ? ` · model ${view.model}` : ""}`,
  );
  if (view.gitHead)
    lines.push(`  git ${view.gitHead.slice(0, 12)} · cwd ${view.cwd ?? "?"}`);
  if (view.cliVersion || view.agent) {
    const parts: string[] = [];
    if (view.agent) parts.push(`agent ${view.agent}`);
    if (view.cliVersion) parts.push(`cli ${view.cliVersion}`);
    lines.push(`  ${parts.join(" · ")}`);
  }
  for (const f of view.feedback) {
    lines.push(
      `  feedback: ${f.verdict}${f.comment ? ` — ${clip(f.comment, 80)}` : ""}`,
    );
  }
  for (const d of view.distills) {
    lines.push(
      `  distilled (${d.reason}) → ${d.isPushed ? `pushed to ${d.datasetSlug ?? "platform"}` : "local only"}`,
    );
  }
  for (const turn of view.turns) {
    lines.push("");
    const status = turn.settled
      ? `${turn.steps ?? 0} step(s)${turn.stopReason ? ` · ${turn.stopReason}` : ""}`
      : "never settled";
    lines.push(`turn ${turn.turn} (${status}) — ${clip(turn.prompt, 100)}`);
    for (const call of turn.toolCalls) {
      lines.push(
        `  tool ${call.name} ${call.ok ? "✓" : "✗"} ${Math.round(call.durationMs)}ms`,
      );
      if (focusTurn === turn.turn) {
        lines.push(`    input:\n${indentPayload(call.input, "      ")}`);
        lines.push(`    output:\n${indentPayload(call.output, "      ")}`);
      }
    }
    if (turn.changedFiles.length > 0)
      lines.push(`  changed: ${turn.changedFiles.join(", ")}`);
    if (turn.usage) {
      lines.push(
        `  usage: ${turn.usage.inputTokens}→${turn.usage.outputTokens} tok · $${turn.usage.costUsd.toFixed(4)}`,
      );
    }
  }
  return lines.join("\n");
}

export interface FleetReplayOptions extends CommonOptions {
  /** Focus turn: print this turn's FULL tool input/output payloads. */
  turn?: string;
  /** Run the integrity check; exit 1 when it fails. */
  verify?: boolean;
}

/**
 * `oxagen fleet replay <sid>` — the time-travel debugger view of a recorded
 * run: run identity, then per turn the prompt, tool calls, changed files, and
 * usage. `--turn N` resolves that turn's full tool I/O from the blob store;
 * `--verify` checks every ref resolves and hashes clean (exit 1 when not).
 */
export async function handleFleetReplay(
  sidRef: string,
  opts: FleetReplayOptions = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json, quiet: opts.quiet }, writer);
  const store = openStore(opts.cwd);
  const opened = await openRecordedRun(store, sidRef, out);
  if (!opened) return;

  let focusTurn: number | undefined;
  if (opts.turn !== undefined) {
    const parsed = parseTurnFlag(opts.turn, 1);
    if (parsed === null) {
      out.error(
        `invalid --turn "${opts.turn}". Use a positive integer.`,
        "usage",
      );
      process.exitCode = 2;
      return;
    }
    focusTurn = parsed;
  }

  const view = await buildReplayView(opened.recordStore, opened.run, focusTurn);
  const verify = opts.verify
    ? await verifyRun(opened.recordStore, opened.run)
    : null;

  if (out.isJson) {
    out.data(verify !== null ? { ...view, verify } : view);
  } else {
    writer.write(renderReplayView(view, focusTurn));
    if (verify !== null) {
      writer.write("");
      writer.write(
        verify.ok
          ? `verify: ok — ${verify.refsChecked} ref(s) checked`
          : `verify: FAILED — ${verify.refsChecked} ref(s) checked`,
      );
      for (const issue of verify.issues) writer.write(`  ✗ ${issue}`);
    }
  }
  if (verify !== null && !verify.ok && !process.exitCode) process.exitCode = 1;
}

// ── bisect ───────────────────────────────────────────────────────────────────

export interface FleetBisectOptions extends CommonOptions {
  /** Predicate command (`sh -c`), run inside the restored tree; exit 0 = good. */
  cmd?: string;
  /** Known-good turn (state AFTER it passes the predicate). Default 0. */
  good?: string;
  /** Known-bad turn. Default: the run's last settled turn. */
  bad?: string;
  /** Injectable exec port (tests). */
  execImpl?: ExecPort;
  /** Injectable predicate runner (tests). */
  runShellImpl?: (cmd: string, cwd: string) => Promise<number>;
}

/**
 * `oxagen fleet bisect <sid> --cmd <shell>` — `git bisect` for agent runs.
 * Binary-searches (goodTurn, badTurn] restoring the recorded tree at each
 * probed turn into a scratch worktree under `<fleetRoot>/scratch/` and running
 * the predicate there. Assumes monotonic badness (once doomed, stays doomed),
 * exactly like git bisect; endpoints are trusted, not probed.
 */
export async function handleFleetBisect(
  sidRef: string,
  opts: FleetBisectOptions = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json, quiet: opts.quiet }, writer);
  const cmd = opts.cmd?.trim();
  if (!cmd) {
    out.error("bisect needs --cmd <shell> (exit 0 = good state).", "usage");
    process.exitCode = 2;
    return;
  }
  const store = openStore(opts.cwd);
  const opened = await openRecordedRun(store, sidRef, out);
  if (!opened) return;
  const { sid, recordStore, run } = opened;
  if (!run.meta?.gitHead) {
    out.error(
      "this run recorded no git baseline (not a git repository at record time) — cannot restore its tree.",
      "no_git",
    );
    return;
  }
  const repoCwd = run.meta.cwd;

  const goodTurn = opts.good !== undefined ? parseTurnFlag(opts.good, 0) : 0;
  const badTurn =
    opts.bad !== undefined ? parseTurnFlag(opts.bad, 1) : run.lastSettledTurn;
  if (goodTurn === null || badTurn === null) {
    out.error("--good/--bad must be non-negative integers.", "usage");
    process.exitCode = 2;
    return;
  }
  if (badTurn <= goodTurn) {
    out.error(
      `nothing to bisect: good turn ${goodTurn} ≥ bad turn ${badTurn} ` +
        `(last settled turn is ${run.lastSettledTurn}).`,
      "usage",
    );
    process.exitCode = 2;
    return;
  }

  const exec = opts.execImpl ?? realExec;
  const sh = opts.runShellImpl ?? runShell;
  const probe = async (turn: number): Promise<boolean> => {
    const scratch = join(
      store.rootDir,
      "scratch",
      `${sid}-t${turn}-${scratchSuffix()}`,
    );
    const restored = await restoreFsAtTurn({
      store: recordStore,
      run,
      turn,
      targetDir: scratch,
      exec,
    });
    for (const warning of restored.warnings)
      out.warn(`turn ${turn}: ${warning}`);
    try {
      const code = await sh(cmd, scratch);
      out.info(
        `probe turn ${turn}: exit ${code} (${code === 0 ? "good" : "bad"})`,
      );
      return code === 0;
    } finally {
      await removeWorktree({ repoCwd, targetDir: scratch, exec });
    }
  };

  let result: Awaited<ReturnType<typeof bisectTurns>>;
  try {
    result = await bisectTurns({ goodTurn, badTurn, probe });
  } catch (err) {
    out.error(err, "bisect");
    return;
  }

  const badView = run.turns.find((t) => t.turn === result.firstBadTurn);
  const summary = {
    sid,
    goodTurn,
    badTurn,
    firstBadTurn: result.firstBadTurn,
    probes: result.probes,
    prompt: badView?.prompt ?? "",
    toolCalls: (badView?.toolCalls ?? []).map((c) => ({
      name: c.name,
      ok: c.ok,
      durationMs: c.durationMs,
    })),
  };
  out.data(summary, () => {
    const lines = [
      `first bad turn: ${result.firstBadTurn} (bisected ${goodTurn}..${badTurn} in ${result.probes.length} probe(s))`,
      `  prompt: ${clip(summary.prompt, 100)}`,
    ];
    for (const call of summary.toolCalls) {
      lines.push(
        `  tool ${call.name} ${call.ok ? "✓" : "✗"} ${Math.round(call.durationMs)}ms`,
      );
    }
    lines.push(
      `inspect it: oxagen fleet replay ${shortSid(sid)} --turn ${result.firstBadTurn}`,
    );
    return lines.join("\n");
  });
}

// ── resume ───────────────────────────────────────────────────────────────────

export interface FleetResumeOptions extends CommonOptions {
  /**
   * Fork point: the state AFTER this turn (0 = session start), or the literal
   * `"last"` for the run's last settled turn — what orphan auto-adoption
   * passes (sessions/adopt.ts) since it can't know each run's turn count.
   * Required.
   */
  turn?: string;
  /** Model override for the fork (default: the source run's model). */
  model?: string;
  /** Prompt override (default: the source's turn N+1 prompt, else its original prompt). */
  prompt?: string;
  /** Injectable exec port (tests). */
  execImpl?: ExecPort;
  /** Injectable spawner (tests). */
  spawnImpl?: DispatchDetachedOptions["spawnImpl"];
}

/**
 * `oxagen fleet resume <sid> --turn N` — fork a recorded session: restore the
 * tree as it stood after turn N into a scratch worktree, then dispatch a
 * detached session there whose history is reconstructed from the record
 * (`meta.resumeOf`). The fork records normally, so forks are replayable. The
 * scratch worktree is the caller's to clean.
 */
export async function handleFleetResume(
  sidRef: string,
  opts: FleetResumeOptions = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json, quiet: opts.quiet }, writer);
  if (opts.turn === undefined) {
    out.error("resume needs --turn <n> (0 = session start).", "usage");
    process.exitCode = 2;
    return;
  }
  const store = openStore(opts.cwd);
  const opened = await openRecordedRun(store, sidRef, out);
  if (!opened) return;
  const { sid, meta, recordStore, run } = opened;

  const turn =
    opts.turn === "last" ? run.lastSettledTurn : parseTurnFlag(opts.turn, 0);
  if (turn === null || turn > run.lastSettledTurn) {
    out.error(
      `invalid --turn "${opts.turn}" — use 0..${run.lastSettledTurn} (the run's last settled turn) or "last".`,
      "usage",
    );
    process.exitCode = 2;
    return;
  }
  if (!run.meta?.gitHead) {
    out.error(
      "this run recorded no git baseline (not a git repository at record time) — cannot restore its tree.",
      "no_git",
    );
    return;
  }

  const exec = opts.execImpl ?? realExec;
  const scratch = join(
    store.rootDir,
    "scratch",
    `resume-${sid}-t${turn}-${scratchSuffix()}`,
  );
  try {
    const restored = await restoreFsAtTurn({
      store: recordStore,
      run,
      turn,
      targetDir: scratch,
      exec,
    });
    for (const warning of restored.warnings) out.warn(warning);
  } catch (err) {
    out.error(err, "restore");
    return;
  }

  // Prompt: explicit override, else the turn the source ran NEXT (rerun it
  // against the fork), else the run's original prompt.
  const nextPrompt = run.turns.find((t) => t.turn === turn + 1)?.prompt;
  const prompt =
    opts.prompt ??
    (nextPrompt && nextPrompt !== "" ? nextPrompt : run.meta.prompt);
  const model = opts.model ?? run.meta.model ?? meta.model;

  const { sid: newSid, title } = await dispatchDetachedSession({
    cwd: scratch,
    // Stay in the SOURCE project's fleet: the scratch worktree would hash to
    // its own fleet root, stranding the worker away from this session's meta
    // and the source record (see DispatchDetachedOptions.fleetCwd).
    fleetCwd: opts.cwd ?? process.cwd(),
    prompt,
    resumeOf: { sid, turn },
    store,
    ...(model !== undefined ? { model } : {}),
    ...(meta.agent !== undefined ? { agent: meta.agent } : {}),
    ...(opts.spawnImpl !== undefined ? { spawnImpl: opts.spawnImpl } : {}),
  });

  out.data(
    {
      sid: newSid,
      title,
      resumedFrom: { sid, turn },
      scratchDir: scratch,
      prompt,
      model: model ?? null,
    },
    () =>
      [
        `resumed ${shortSid(sid)} after turn ${turn} → ${newSid}`,
        `  worktree: ${scratch} (yours to clean when done)`,
        `  watch it: oxagen fleet attach ${shortSid(newSid)}`,
      ].join("\n"),
  );
}

// ── feedback ─────────────────────────────────────────────────────────────────

export interface FleetFeedbackOptions extends CommonOptions {
  /** Optional free-text comment attached to the verdict. */
  message?: string;
}

/**
 * Build the evals-v1 item for a recorded run: prompt as input, provenance +
 * failure forensics as metadata (last envelope error, changed-file union).
 */
async function buildDistilledItem(args: {
  store: SessionStore;
  run: ReplayRun;
  meta: SessionMetaView;
  reason: DistillReason;
  feedbackComment?: string;
}): Promise<DistilledEvalItem> {
  const { run, meta } = args;
  // The record has no error events — the last salient error lives on the envelope.
  const events = await args.store.readEvents(meta.sid);
  const errors = events.filter((e) => e.type === "error");
  const lastError = errors[errors.length - 1]?.message;
  const changedFiles = [
    ...new Set(run.turns.flatMap((t) => t.end?.changedFiles ?? [])),
  ];
  return distillEvalItem({
    sid: meta.sid,
    prompt: run.meta?.prompt ?? meta.prompt,
    reason: args.reason,
    fate: meta.state,
    model: run.meta?.model ?? meta.model,
    agent: run.meta?.agent ?? meta.agent,
    turns: run.lastSettledTurn,
    errorMessage: lastError,
    changedFiles,
    feedbackComment: args.feedbackComment,
    cliVersion: run.meta?.cliVersion,
    gitHead: run.meta?.gitHead,
    distilledAt: Date.now(),
  });
}

/** Blob-store the item + write the human-readable `record/distilled.json` copy. */
async function persistDistilledItem(
  recordStore: RecordStore,
  item: DistilledEvalItem,
): Promise<string> {
  const blob = await recordStore.putJsonBlob(item);
  await writeFile(
    join(recordStore.rootDir, "distilled.json"),
    JSON.stringify(item, null, 2) + "\n",
  );
  return blob.ref;
}

/**
 * `oxagen fleet feedback <sid> up|down` — append a human verdict to a finished
 * session's record log (NOT the envelope — no public-contract change). A
 * thumbs-down auto-distills the run into a local eval item, like a failure.
 */
export async function handleFleetFeedback(
  sidRef: string,
  verdict: string,
  opts: FleetFeedbackOptions = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json, quiet: opts.quiet }, writer);
  if (verdict !== "up" && verdict !== "down") {
    out.error(
      `feedback verdict must be "up" or "down" (got "${verdict}").`,
      "usage",
    );
    process.exitCode = 2;
    return;
  }
  const store = openStore(opts.cwd);
  const opened = await openRecordedRun(store, sidRef, out);
  if (!opened) return;
  const { sid, meta, recordStore, run } = opened;
  if (!TERMINAL_STATES.has(meta.state)) {
    out.error(
      `session ${shortSid(sid)} is ${meta.derivedState}; feedback needs a finished (done/failed/cancelled) session.`,
      "not_terminal",
    );
    return;
  }

  const records = await recordStore.readRecords();
  const recordWriter = openPostHocWriter(recordStore, sid, records);
  const comment = opts.message?.trim();
  recordWriter.append({
    t: "feedback",
    verdict,
    ...(comment ? { comment } : {}),
  });

  // A thumbs-down IS a failure signal — distill exactly like the runner's
  // failed path, with the human's reason and comment attached.
  let isDistilled = false;
  if (verdict === "down") {
    try {
      const item = await buildDistilledItem({
        store,
        run,
        meta,
        reason: "thumbs_down",
        ...(comment ? { feedbackComment: comment } : {}),
      });
      const itemRef = await persistDistilledItem(recordStore, item);
      recordWriter.append({
        t: "distill",
        reason: "thumbs_down",
        itemRef,
        isPushed: false,
      });
      isDistilled = true;
    } catch (err) {
      // Best-effort like the runner's path: the verdict still lands.
      out.warn(
        `could not distill: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  await recordWriter.flush();

  out.data({ sid, verdict, ...(comment ? { comment } : {}), isDistilled }, () =>
    [
      `recorded ${verdict === "up" ? "👍" : "👎"} on ${shortSid(sid)}${comment ? ` — ${clip(comment, 80)}` : ""}`,
      ...(isDistilled
        ? [
            `distilled to record/distilled.json — push it: oxagen fleet distill ${shortSid(sid)} --push`,
          ]
        : []),
    ].join("\n"),
  );
}

// ── distill ──────────────────────────────────────────────────────────────────

/** Reason precedence for a manual distill: thumbs-down → failed → manual. */
export function distillReasonFor(run: ReplayRun, state: string): DistillReason {
  if (run.feedback.some((f) => f.verdict === "down")) return "thumbs_down";
  if (state === "failed") return "failed";
  return "manual";
}

/** Find the dataset with `slug`, or create it; returns its public id. */
async function findOrCreateDataset(slug: string): Promise<string> {
  const { datasets } = await apiGetOrThrow<{
    datasets: Array<{ datasetId: string; slug: string }>;
  }>("eval/datasets");
  const existing = datasets.find((d) => d.slug === slug);
  if (existing) return existing.datasetId;
  const created = await apiPostOrThrow<{
    datasetId: string;
    publicId: string;
    slug: string;
  }>("eval/datasets", {
    name: slug === DISTILL_DATASET_SLUG ? "Fleet distilled failures" : slug,
    slug,
  });
  return created.publicId;
}

export interface FleetDistillOptions extends CommonOptions {
  /** Push the item to the platform through the governed eval.* capabilities. */
  push?: boolean;
  /** Target dataset slug (default: the shared fleet-distilled-failures dataset). */
  dataset?: string;
}

/**
 * `oxagen fleet distill <sid>` — turn a recorded run into an evals-v1 dataset
 * item: written locally to `record/distilled.json` always; `--push` also
 * find-or-creates the dataset by slug and adds the item via the existing
 * `eval.dataset.*` capabilities (metered, IAM-gated — no new contract surface).
 */
export async function handleFleetDistill(
  sidRef: string,
  opts: FleetDistillOptions = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput({ json: opts.json, quiet: opts.quiet }, writer);
  const store = openStore(opts.cwd);
  const opened = await openRecordedRun(store, sidRef, out);
  if (!opened) return;
  const { sid, meta, recordStore, run } = opened;

  const reason = distillReasonFor(run, meta.state);
  const downComment = [...run.feedback]
    .reverse()
    .find((f) => f.verdict === "down")?.comment;
  let item: DistilledEvalItem;
  try {
    item = await buildDistilledItem({
      store,
      run,
      meta,
      reason,
      ...(downComment !== undefined ? { feedbackComment: downComment } : {}),
    });
  } catch (err) {
    out.error(err, "distill"); // e.g. a run with an empty prompt
    return;
  }
  const itemRef = await persistDistilledItem(recordStore, item);

  const datasetSlug = opts.dataset ?? DISTILL_DATASET_SLUG;
  let isPushed = false;
  let pushError: string | null = null;
  if (opts.push) {
    if (!resolveApiContext()) {
      pushError =
        "not logged in — run `oxagen login` (or set OXAGEN_API_TOKEN / OXAGEN_ORG_ID / " +
        "OXAGEN_WORKSPACE_ID) before --push. The item was still written locally.";
    } else {
      try {
        const datasetPublicId = await findOrCreateDataset(datasetSlug);
        await apiPostOrThrow("eval/datasets/items", {
          datasetPublicId,
          items: [item],
        });
        isPushed = true;
      } catch (err) {
        pushError = err instanceof Error ? err.message : String(err);
      }
    }
  }

  // The distill record's isPushed reflects reality — including a failed push.
  const records = await recordStore.readRecords();
  const recordWriter = openPostHocWriter(recordStore, sid, records);
  recordWriter.append({
    t: "distill",
    reason,
    itemRef,
    ...(opts.push ? { datasetSlug } : {}),
    isPushed,
  });
  await recordWriter.flush();

  if (pushError !== null) {
    out.error(pushError, "push");
    return;
  }
  out.data(
    {
      sid,
      reason,
      itemRef,
      isPushed,
      ...(opts.push ? { datasetSlug } : {}),
      item,
    },
    () =>
      [
        `distilled ${shortSid(sid)} (${reason}) → record/distilled.json`,
        isPushed
          ? `pushed to dataset "${datasetSlug}"`
          : `local only — push it: oxagen fleet distill ${shortSid(sid)} --push`,
      ].join("\n"),
  );
}

// ── worker (hidden) ──────────────────────────────────────────────────────────

export interface FleetWorkerOptions {
  cwd?: string;
  /** Inject a fake runner in tests; defaults to the real engine loop. */
  runSessionImpl?: typeof RunSession;
}

/**
 * `oxagen fleet worker <sid>` — the detached worker entry `dispatch` spawns.
 * Resolves the fleet from `cwd`, reads the session's meta, stamps its own pid,
 * runs the session to completion, and returns the exit code for its fate
 * (0 done · 1 failed · 130 cancelled). Returns `{ code: 1 }` when the sid is
 * unknown so the caller can exit without a real engine run.
 */
export async function handleFleetWorker(
  sid: string,
  opts: FleetWorkerOptions = {},
  writer: CommandWriter = stdoutWriter,
): Promise<{ code: number }> {
  const out = createOutput({}, writer);
  const store = openStore(opts.cwd);
  const view = await store.readMeta(sid);
  if (!view) {
    out.error(`no session ${sid} in this fleet.`);
    return { code: 1 };
  }

  // Stamp our pid so orphan detection sees a live owner immediately (dispatch
  // creates the session with pid 0 — "the worker stamps its real pid on boot").
  const { alive: _alive, derivedState: _derived, ...base } = view;
  const meta: SessionMeta = { ...base, pid: process.pid };
  const pidWriter = store.openWriter(meta);
  pidWriter.patchMeta({ pid: process.pid });
  await pidWriter.flush();

  const runSession =
    opts.runSessionImpl ?? (await import("../sessions/runner.js")).runSession;
  const { state } = await runSession({ store, meta });
  return { code: state === "done" ? 0 : state === "cancelled" ? 130 : 1 };
}

// ── root (`oxagen fleet` with no subcommand) ─────────────────────────────────

export interface FleetRootOptions extends CommonOptions {
  verbose?: boolean;
  stdoutIsTTY?: boolean;
  signal?: AbortSignal;
}

/**
 * `oxagen fleet` — Mission Control in a terminal; piped or `--json`, an alias of
 * `fleet watch --json` over the whole fleet.
 */
export async function handleFleetRoot(
  opts: FleetRootOptions = {},
  writer: CommandWriter = stdoutWriter,
): Promise<void> {
  const out = createOutput(
    {
      json: opts.json,
      quiet: opts.quiet,
      autoJson: true,
      // One TTY truth: the injected override must steer autoJson AND the
      // interactive branch below, or a test/caller can land in a mode split.
      ...(opts.stdoutIsTTY !== undefined
        ? { stdoutIsTTY: opts.stdoutIsTTY }
        : {}),
    },
    writer,
  );
  // Non-TTY or --json → the merged watch-all stream (the documented alias).
  if (out.isJson || !stdoutIsTty(opts.stdoutIsTTY)) {
    await handleFleetWatch(
      [],
      {
        ...(opts.json !== undefined ? { json: opts.json } : {}),
        ...(opts.quiet !== undefined ? { quiet: opts.quiet } : {}),
        ...(opts.verbose !== undefined ? { verbose: opts.verbose } : {}),
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      },
      writer,
    );
    return;
  }

  // Interactive path needs a real terminal (Ink); refuse the REPL capture seam.
  if (writer !== stdoutWriter) {
    out.info("open a full terminal and run: oxagen fleet");
    return;
  }

  await launchMissionControlFor(opts.cwd);
}

/**
 * Boot Mission Control over this project's fleet. The manager (and through it
 * the engine) loads lazily — headless verbs never pay for Ink or the runner.
 */
async function launchMissionControlFor(
  cwd: string | undefined,
  focusSid?: string,
): Promise<void> {
  const projectCwd = cwd ?? process.cwd();
  const store = openStore(cwd);
  const [{ FleetSessionManager }, { launchMissionControl }] = await Promise.all(
    [
      import("../sessions/manager.js"),
      import("../tui/mission-control/index.js"),
    ],
  );
  const manager = new FleetSessionManager({ store, cwd: projectCwd });
  await launchMissionControl({
    store,
    manager,
    cwd: projectCwd,
    ...(focusSid !== undefined ? { focusSid } : {}),
  });
}
