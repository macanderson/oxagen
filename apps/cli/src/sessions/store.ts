/**
 * The session store (ADR-023) — sessions as append-only event logs on disk.
 *
 * Layout, per project (`fleetRoot(cwd)`):
 *
 *   sessions/<sid>/meta.json      atomically-replaced roster snapshot
 *   sessions/<sid>/events.ndjson  the append-only event log (envelope v1)
 *   sessions/<sid>/inbox.ndjson   control channel: anyone appends, owner consumes
 *
 * Ownership: exactly ONE process (the `pid` in meta) runs the engine loop and
 * appends events; every other process is a reader (`readEvents`/`tailEvents`/
 * `watchSessions`) or a controller (`appendInbox`). A session whose owner pid
 * is dead but whose recorded state is non-terminal derives as `orphaned` at
 * read time — the store never trusts a dead process's last word.
 *
 * Durability stance: appends are serialized per writer but never fsync'd — a
 * hard crash may lose the tail lines, which `parseSessionEventLine`'s
 * tolerance absorbs on the read side. `meta.json` is written via tmp+rename so
 * rosters never see a torn JSON document.
 *
 * Liveness stance: every tail runs fs.watch for sub-50 ms latency AND a
 * 300 ms poll as the floor — fs.watch is best-effort on some filesystems, and
 * a poll from a saved byte offset is one stat() when nothing changed.
 */
import { watch, type FSWatcher } from "node:fs";
import {
  appendFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  EVENT_SCHEMA_VERSION,
  parseSessionEventLine,
  serializeSessionEvent,
  sessionStateSchema,
  turnUsageSchema,
  emptyTurnUsage,
  type SessionEvent,
  type SessionEventInput,
  type SessionState,
  type TurnUsage,
} from "./events.js";
import { sessionDir } from "./paths.js";

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

export const sessionMetaSchema = z.object({
  v: z.literal(EVENT_SCHEMA_VERSION),
  sid: z.string().min(1),
  title: z.string(),
  prompt: z.string(),
  state: sessionStateSchema,
  owner: z.enum(["tui", "worker"]),
  pid: z.number().int(),
  cwd: z.string(),
  mode: z.enum(["conversation", "once"]),
  model: z.string().optional(),
  agent: z.string().optional(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  endedAt: z.number().int().optional(),
  turns: z.number().int().nonnegative(),
  lastSeq: z.number().int().nonnegative(),
  usage: turnUsageSchema,
  /** Last assistant text, capped — the roster's one-line summary. */
  summary: z.string().optional(),
  /** Last salient activity ("wrote src/auth.ts"), for live rosters. */
  lastActivity: z.string().optional(),
  /**
   * Fork provenance (ADR-028): this session resumed another session's state
   * after `turn`. The runner seeds its model history from the source session's
   * replay record. Additive and optional — pre-ADR-028 metas parse unchanged.
   */
  resumeOf: z
    .object({ sid: z.string().min(1), turn: z.number().int().nonnegative() })
    .optional(),
});
export type SessionMeta = z.infer<typeof sessionMetaSchema>;

/** Meta plus read-time liveness derivation (never persisted). */
export interface SessionMetaView extends SessionMeta {
  /** True when the owning process is alive right now. */
  alive: boolean;
  /**
   * `meta.state`, except a non-terminal state whose owner is dead derives to
   * `"orphaned"` — the correct roster state for a crashed/killed owner.
   */
  derivedState: SessionState | "orphaned";
}

const NON_TERMINAL: ReadonlySet<SessionState> = new Set([
  "queued",
  "running",
  "waiting",
]);

/** True when `state` means the session can still emit events. */
export function isActiveState(state: SessionState | "orphaned"): boolean {
  return NON_TERMINAL.has(state as SessionState);
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = alive but not ours; anything else (ESRCH) = gone.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function deriveView(meta: SessionMeta): SessionMetaView {
  const alive = isPidAlive(meta.pid);
  const derivedState: SessionMetaView["derivedState"] =
    !alive && NON_TERMINAL.has(meta.state) ? "orphaned" : meta.state;
  return { ...meta, alive, derivedState };
}

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------

export const inboxMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message"),
    text: z.string().min(1),
    ts: z.number().int(),
  }),
  z.object({ type: z.literal("cancel"), ts: z.number().int() }),
]);
export type InboxMessage = z.infer<typeof inboxMessageSchema>;

// ---------------------------------------------------------------------------
// NDJSON tailing (shared by events + inbox)
// ---------------------------------------------------------------------------

export interface TailHandle {
  /** Stop watching. Idempotent. */
  stop(): void;
}

interface TailOptions {
  /** Poll floor in ms (default 300). fs.watch accelerates below this. */
  intervalMs?: number;
  signal?: AbortSignal;
}

/**
 * Follow an NDJSON file from byte 0: replay what exists, then stream new
 * complete lines as they are appended. Torn tail lines wait for their
 * newline; `onLine` receives raw lines (parsing is the caller's).
 */
function tailNdjson(
  file: string,
  onLine: (line: string) => void,
  opts: TailOptions = {},
): TailHandle {
  const intervalMs = opts.intervalMs ?? 300;
  let offset = 0;
  let remainder = "";
  let stopped = false;
  let pumping = false;
  let watcher: FSWatcher | null = null;

  const pump = async (): Promise<void> => {
    if (stopped || pumping) return;
    pumping = true;
    try {
      const info = await stat(file).catch(() => null);
      if (!info || info.size <= offset) return;
      const fh = await open(file, "r");
      try {
        const length = info.size - offset;
        const buffer = Buffer.alloc(Number(length));
        const { bytesRead } = await fh.read(buffer, 0, buffer.length, offset);
        offset += bytesRead;
        remainder += buffer.subarray(0, bytesRead).toString("utf8");
        const lines = remainder.split("\n");
        remainder = lines.pop() ?? "";
        for (const line of lines) {
          if (stopped) return;
          if (line.trim() !== "") onLine(line);
        }
      } finally {
        await fh.close();
      }
    } catch {
      // A vanished file (clean() raced us) or transient IO error: the next
      // poll retries; tailing must never throw into the caller.
    } finally {
      pumping = false;
    }
  };

  const timer = setInterval(() => void pump(), intervalMs);
  timer.unref?.();
  try {
    watcher = watch(file, { persistent: false }, () => void pump());
  } catch {
    watcher = null; // File may not exist yet or fs.watch unsupported — poll covers it.
  }
  void pump();

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    watcher?.close();
    // Detach from the signal too: one long-lived signal (a REPL-session
    // controller) can outlive thousands of tails, and a `{ once: true }`
    // listener is only auto-removed when the signal FIRES — manual stop()
    // must not leave it accumulating.
    opts.signal?.removeEventListener("abort", stop);
  };
  opts.signal?.addEventListener("abort", stop, { once: true });
  return { stop };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface CreateSessionInit {
  sid: string;
  title: string;
  prompt: string;
  owner: SessionMeta["owner"];
  pid: number;
  cwd: string;
  mode: SessionMeta["mode"];
  model?: string;
  agent?: string;
  state?: SessionState;
  /** Fork provenance (ADR-028): resume from this session's state after `turn`. */
  resumeOf?: SessionMeta["resumeOf"];
}

/**
 * The writer half of one session — held ONLY by the owning process. Stamps
 * `v`/`sid`/`seq`/`ts`, serializes appends so event order on disk always
 * matches emission order, and keeps `meta.json` in step.
 */
export interface SessionWriter {
  readonly sid: string;
  /** Append one event; resolves once the line is on its way to disk. */
  append(input: SessionEventInput): SessionEvent;
  /** Merge a patch into meta (updatedAt auto-stamped). */
  patchMeta(patch: Partial<SessionMeta>): void;
  /** Await every queued append/meta write (call before process exit). */
  flush(): Promise<void>;
}

export class SessionStore {
  private readonly root: string;

  constructor(opts: { root: string }) {
    this.root = opts.root;
  }

  get rootDir(): string {
    return this.root;
  }

  private dir(sid: string): string {
    return sessionDir(this.root, sid);
  }

  /** Create the session directory, initial meta, and empty log/inbox files. */
  async createSession(init: CreateSessionInit): Promise<SessionMeta> {
    const dir = this.dir(init.sid);
    await mkdir(dir, { recursive: true });
    const now = Date.now();
    const meta: SessionMeta = {
      v: EVENT_SCHEMA_VERSION,
      sid: init.sid,
      title: init.title,
      prompt: init.prompt,
      state: init.state ?? "queued",
      owner: init.owner,
      pid: init.pid,
      cwd: init.cwd,
      mode: init.mode,
      ...(init.model !== undefined ? { model: init.model } : {}),
      ...(init.agent !== undefined ? { agent: init.agent } : {}),
      ...(init.resumeOf !== undefined ? { resumeOf: init.resumeOf } : {}),
      createdAt: now,
      updatedAt: now,
      turns: 0,
      lastSeq: 0,
      usage: emptyTurnUsage(),
    };
    await this.writeMetaAtomic(init.sid, meta);
    await Promise.all([
      appendFile(join(dir, "events.ndjson"), ""),
      appendFile(join(dir, "inbox.ndjson"), ""),
    ]);
    return meta;
  }

  /**
   * Open the writer for a session this process owns. `meta` must be the
   * current on-disk meta (from {@link createSession} or {@link readMeta});
   * its `lastSeq` seeds the sequence counter so a worker resuming its own
   * session keeps `seq` monotonic.
   */
  openWriter(meta: SessionMeta): SessionWriter {
    const dir = this.dir(meta.sid);
    const eventsFile = join(dir, "events.ndjson");
    let seq = meta.lastSeq;
    let current: SessionMeta = { ...meta };
    // One promise chain per writer: append order === emission order, and a
    // meta patch never races the event that motivated it.
    let queue: Promise<void> = Promise.resolve();
    let metaQueued = false;

    const enqueue = (work: () => Promise<void>): void => {
      queue = queue.then(work, work);
      // A queued append/meta write can lose its race with process or temp-dir
      // teardown (a late appendFile → ENOENT). Such a best-effort write must
      // never crash the runtime as an unhandled rejection — attach an inert
      // catch to the tail. `flush()` still `await`s `queue` and, as an
      // independent handler on the same promise, continues to observe real
      // write errors for callers that flush before exit.
      queue.catch(() => {});
    };

    const scheduleMetaWrite = (): void => {
      if (metaQueued) return;
      metaQueued = true;
      enqueue(async () => {
        metaQueued = false;
        await this.writeMetaAtomic(current.sid, current);
      });
    };

    return {
      sid: meta.sid,
      append: (input: SessionEventInput): SessionEvent => {
        seq += 1;
        const event = {
          v: EVENT_SCHEMA_VERSION,
          sid: current.sid,
          seq,
          ts: Date.now(),
          ...input,
        } as SessionEvent;
        const line = serializeSessionEvent(event) + "\n";
        enqueue(() => appendFile(eventsFile, line));
        current = { ...current, lastSeq: seq, updatedAt: event.ts };
        scheduleMetaWrite();
        return event;
      },
      patchMeta: (patch: Partial<SessionMeta>): void => {
        current = {
          ...current,
          ...patch,
          sid: current.sid,
          updatedAt: Date.now(),
        };
        scheduleMetaWrite();
      },
      flush: async (): Promise<void> => {
        await queue;
      },
    };
  }

  private async writeMetaAtomic(sid: string, meta: SessionMeta): Promise<void> {
    const dir = this.dir(sid);
    const tmp = join(dir, `.meta.${process.pid}.tmp`);
    await writeFile(tmp, JSON.stringify(meta));
    await rename(tmp, join(dir, "meta.json"));
  }

  async readMeta(sid: string): Promise<SessionMetaView | null> {
    try {
      const raw = await readFile(join(this.dir(sid), "meta.json"), "utf8");
      const parsed = sessionMetaSchema.safeParse(JSON.parse(raw));
      return parsed.success ? deriveView(parsed.data) : null;
    } catch {
      return null;
    }
  }

  /** Every session in this fleet, newest first. Unreadable metas are skipped. */
  async listSessions(): Promise<SessionMetaView[]> {
    const sessionsDir = join(this.root, "sessions");
    let entries: string[];
    try {
      entries = await readdir(sessionsDir);
    } catch {
      return [];
    }
    const metas = await Promise.all(entries.map((sid) => this.readMeta(sid)));
    return metas
      .filter((m): m is SessionMetaView => m !== null)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** All events currently on disk for `sid` (optionally from a sequence). */
  async readEvents(
    sid: string,
    opts: { fromSeq?: number } = {},
  ): Promise<SessionEvent[]> {
    const fromSeq = opts.fromSeq ?? 1;
    let raw: string;
    try {
      raw = await readFile(join(this.dir(sid), "events.ndjson"), "utf8");
    } catch {
      return [];
    }
    const events: SessionEvent[] = [];
    for (const line of raw.split("\n")) {
      const event = parseSessionEventLine(line);
      if (event && event.seq >= fromSeq) events.push(event);
    }
    return events;
  }

  /**
   * Replay `sid`'s log from `fromSeq` (default: the beginning), then keep
   * streaming new events live. Works identically on sessions owned by this
   * process and by others — this is what makes a second terminal's
   * `fleet watch` and the TUI's adoption of foreign sessions the same code.
   */
  tailEvents(
    sid: string,
    onEvent: (event: SessionEvent) => void,
    opts: TailOptions & { fromSeq?: number } = {},
  ): TailHandle {
    const fromSeq = opts.fromSeq ?? 1;
    return tailNdjson(
      join(this.dir(sid), "events.ndjson"),
      (line) => {
        const event = parseSessionEventLine(line);
        if (event && event.seq >= fromSeq) onEvent(event);
      },
      opts,
    );
  }

  /** Append a control message to `sid`'s inbox (any process may call). */
  async appendInbox(sid: string, message: InboxMessage): Promise<void> {
    await appendFile(
      join(this.dir(sid), "inbox.ndjson"),
      JSON.stringify(message) + "\n",
    );
  }

  /** Owner-side: consume inbox messages as they arrive (replays existing). */
  tailInbox(
    sid: string,
    onMessage: (message: InboxMessage) => void,
    opts: TailOptions = {},
  ): TailHandle {
    return tailNdjson(
      join(this.dir(sid), "inbox.ndjson"),
      (line) => {
        try {
          const parsed = inboxMessageSchema.safeParse(JSON.parse(line));
          if (parsed.success) onMessage(parsed.data);
        } catch {
          // Foreign junk in the inbox is ignored, never fatal.
        }
      },
      opts,
    );
  }

  /**
   * Roster watch: emit the full session list on any change (state, usage,
   * new/removed sessions). 1 s poll + directory watch for fast adds.
   */
  watchSessions(
    onChange: (sessions: SessionMetaView[]) => void,
    opts: TailOptions = {},
  ): TailHandle {
    const intervalMs = opts.intervalMs ?? 1000;
    let fingerprint = "";
    let stopped = false;
    let scanning = false;
    let watcher: FSWatcher | null = null;

    const scan = async (): Promise<void> => {
      if (stopped || scanning) return;
      scanning = true;
      try {
        const sessions = await this.listSessions();
        const next = sessions
          .map((s) => `${s.sid}:${s.derivedState}:${s.updatedAt}:${s.lastSeq}`)
          .join("|");
        if (next !== fingerprint) {
          fingerprint = next;
          if (!stopped) onChange(sessions);
        }
      } finally {
        scanning = false;
      }
    };

    const timer = setInterval(() => void scan(), intervalMs);
    timer.unref?.();
    try {
      watcher = watch(
        join(this.root, "sessions"),
        { persistent: false },
        () => void scan(),
      );
    } catch {
      watcher = null;
    }
    void scan();

    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      watcher?.close();
      // Same signal hygiene as tailNdjson: manual stop must detach the
      // abort listener or repeated watches against one signal accumulate.
      opts.signal?.removeEventListener("abort", stop);
    };
    opts.signal?.addEventListener("abort", stop, { once: true });
    return { stop };
  }

  /**
   * Prune sessions that are terminal (or orphaned) and idle past the cutoff.
   * Live sessions are never touched.
   */
  async clean(
    opts: { olderThanMs?: number; all?: boolean } = {},
  ): Promise<{ removed: string[] }> {
    const olderThanMs = opts.olderThanMs ?? 7 * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - (opts.all ? 0 : olderThanMs);
    const removed: string[] = [];
    for (const meta of await this.listSessions()) {
      const inert = !isActiveState(meta.derivedState);
      if (inert && meta.updatedAt <= cutoff) {
        await rm(this.dir(meta.sid), { recursive: true, force: true });
        removed.push(meta.sid);
      }
    }
    return { removed };
  }
}

/** Convenience: build a store rooted at the fleet root for `cwd`. */
export function openFleetStore(root: string): SessionStore {
  return new SessionStore({ root });
}

export type { TurnUsage };
