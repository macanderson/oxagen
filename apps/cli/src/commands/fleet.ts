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
import { createOutput, type Output } from "../lib/output.js";
import { stdoutWriter, type CommandWriter } from "../lib/capture-writer.js";
import {
  isActiveState,
  openFleetStore,
  type SessionMeta,
  type SessionMetaView,
  type SessionStore,
  type TailHandle,
} from "../sessions/store.js";
import { fleetRoot } from "../sessions/paths.js";
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
  writer.write(render.gutter ? `${shortSid(line.sid).padEnd(6)} ${line.text}` : line.text);
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
function renderLsTable(sessions: SessionMetaView[], now: number = Date.now()): string {
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
    prompt = (opts.readStdin ? await opts.readStdin() : await readStdin()).trim();
  }
  if (prompt === "" || prompt === "-") {
    out.error('dispatch needs a prompt (arguments, or piped stdin with "-").', "usage");
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
      ...(opts.stdoutIsTTY !== undefined ? { stdoutIsTTY: opts.stdoutIsTTY } : {}),
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
    out.info(`open a full terminal and run: oxagen fleet attach ${shortSid(resolved)}`);
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
    out.error(`session ${shortSid(meta.sid)} is ${meta.derivedState}; cannot send to it.`);
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
  out.data({ sid: meta.sid, ok: true }, () => `→ sent to ${shortSid(meta.sid)}`);
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
    opts.killImpl ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));

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
    const meta = resolved ? sessions.find((s) => s.sid === resolved) : undefined;
    if (!meta) {
      out.error(`no session matching "${sidRef}"`);
      return;
    }
    targets = [meta];
  }

  const results: CancelResult[] = [];
  for (const s of targets) {
    if (!isActiveState(s.derivedState)) {
      results.push({ sid: s.sid, cancelled: false, signalled: false, reason: `already ${s.derivedState}` });
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
      out.error(`invalid --from-seq "${opts.fromSeq}". Use a positive integer.`, "usage");
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
  const tail = store.tailEvents(resolved, (event) => emitEvent(out, writer, event, render), {
    fromSeq,
  });
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

  const { removed } = await openStore(opts.cwd).clean({ olderThanMs, all: opts.all });
  out.data({ removed, count: removed.length }, () =>
    removed.length === 0
      ? "Nothing to prune."
      : `Pruned ${removed.length} session(s): ${removed.map(shortSid).join(", ")}`,
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

  const runSession = opts.runSessionImpl ?? (await import("../sessions/runner.js")).runSession;
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
      ...(opts.stdoutIsTTY !== undefined ? { stdoutIsTTY: opts.stdoutIsTTY } : {}),
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
async function launchMissionControlFor(cwd: string | undefined, focusSid?: string): Promise<void> {
  const projectCwd = cwd ?? process.cwd();
  const store = openStore(cwd);
  const [{ FleetSessionManager }, { launchMissionControl }] = await Promise.all([
    import("../sessions/manager.js"),
    import("../tui/mission-control/index.js"),
  ]);
  const manager = new FleetSessionManager({ store, cwd: projectCwd });
  await launchMissionControl({
    store,
    manager,
    cwd: projectCwd,
    ...(focusSid !== undefined ? { focusSid } : {}),
  });
}
