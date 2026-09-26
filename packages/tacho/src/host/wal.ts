/**
 * The write-ahead log (spec section 3 "WAL"): one append-only NDJSON file
 * per session under `wal/`, plus a cursor of what the control plane has
 * acknowledged. Events are sealed before they land here, so the file is the
 * chain; a batch is "shipped" only when ingest accepted it, and ingest is
 * idempotent on `event_id_idem`, which makes delivery at-least-once safe.
 *
 * Frame bodies (the prompt, the tool input and result, the assistant
 * message) live in a second file beside the session's events,
 * `<session>.bodies.jsonl`, one base64 line per event that carries one. They
 * are kept apart because the event file is the chain and a body can be a
 * megabyte. Reads decode one line at a time; the shipped cursor covers both,
 * since a body only ever ships with its event.
 *
 * That file is the one store for a run's content on this host (ADR-139). Every
 * other place content passes through is a hand-off: the spool holds a hook
 * payload until the daemon drains it, and the daemon's terminal journal holds a
 * sealed batch until it lands here. A hand-off is retried, so `appendRecovered`
 * answers a body the store already holds by not writing it again.
 *
 * NDJSON rather than SQLite keeps the package free of native modules and keeps
 * a read cheap enough to do on every tick.
 *
 * Shipping a batch costs the batch, not the session. Two indexes hold that
 * line, and both are derived from the files and rebuilt whenever they
 * disagree with them:
 *
 * - `BodyIndexStore` (`wal-index.ts`) records the byte offset of every stored
 *   body, so `bodiesFor` seeks to the batch's bodies instead of reading the
 *   session's history to find them. `bodiesForAsync` builds that index off the
 *   synchronous path and hands the shipper the batch in slices, so the daemon
 *   keeps answering while a long session is read.
 * - `resume` records, per session, the byte the shipped cursor sits at, so
 *   `unshipped` and `stats` read the unshipped tail rather than the file.
 *
 * Before those, a session with 16,000 model bodies re-read its 7 GB body file
 * for every 200 events, `health()` parsed every event file on every batch, and
 * a day of runs never reached the record (issue #3694).
 *
 * These files have exactly one writer, the daemon: `append` is reached only
 * from its recording path, and `tacho-hook` running while the daemon is down
 * writes to the spool directory instead (`hook-client.ts`), which the daemon
 * drains later. This file used to say the hook appended here, which is why
 * `dropBodies` and `purgeBodiesOutsideMandate` explain what they rely on: a
 * read-filter-rewrite is safe only for a single writer, and a second writer
 * would need a tombstone rather than a rewrite.
 */
import {
  appendFileSync,
  closeSync,
  fdatasyncSync,
  fsyncSync,
  openSync,
  existsSync,
  readdirSync,
  readSync,
  readFileSync,
  truncateSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { TachoEvent } from "../envelope";
import {
  contentClassOf,
  type FrameBody,
  retentionAllows,
} from "../evidence/frame-body";
import type { RetentionMandate } from "../evidence/retention";
import type { TachoBody } from "../wire";
import {
  ensureDir,
  readJsonFileIfExists,
  writeSensitiveFileAtomic,
} from "./fs";
import {
  BodyIndexStore,
  parseStoredBody,
  readLinesFrom,
  readTailLine,
  type StoredBody,
} from "./wal-index";

/**
 * Events handed to `bodiesForAsync` between two turns of the event loop. Small
 * enough that one slice's reads finish in a few milliseconds, so a control
 * plane fetch or a `/status` request waits for a slice and not for a batch.
 */
const BODY_READ_SLICE = 32;

/**
 * An event written with a seq more than one past the session's last. Only
 * sessions this process has already read or written are checked.
 */
export interface WalChainGap {
  session_uuid: string;
  after_seq: number;
  seq: number;
  kind: string;
}

export interface WalBodyFailure {
  session_uuid: string;
  operation: "append" | "read" | "cleanup";
  code: string;
}

/** An event line this process could not parse, reported rather than thrown. */
export interface WalEventParseFailure {
  session_uuid: string;
  reason: string;
}

export interface WalStats {
  sessions: number;
  unshipped: number;
  oldestUnshippedAt?: string;
}

/**
 * A retried batch holds an event at a seq the file already holds with a
 * different hash. The batch was sealed on a chain that is not the one on
 * disk, so no retry of it can ever land: the caller has to set it aside
 * rather than offer it again.
 */
export class WalRecoveryConflict extends Error {
  constructor(
    readonly sessionUuid: string,
    readonly seq: number,
  ) {
    super(`WAL recovery conflict at ${sessionUuid}:${seq}`);
    this.name = "WalRecoveryConflict";
  }
}

interface Cursor {
  shipped: Record<string, number>;
  sealed: Record<string, string>;
}

export class Wal {
  private readonly dir: string;
  private readonly cursorPath: string;
  private cursor: Cursor;
  /**
   * The highest seq this process has seen in each session's event file. A
   * host running a few hundred sessions holds over a thousand files and
   * hundreds of megabytes, nearly all of it shipped. Without this index,
   * `unshipped` and `stats` parsed every file on every drain and every health
   * probe, which blocked the event loop for seconds at a time, so the shipper
   * fell behind and `tacho status` timed out on a live daemon. Filled lazily,
   * one read per session per process, and kept current by `append`.
   */
  private readonly lastSeq = new Map<string, number>();
  /**
   * Where each session's shipped cursor sits in its event file. `unshipped`
   * and `stats` resumed from the top of the file, so a session with 20,000
   * events parsed all of them for every 200 the shipper took, and `health()`
   * did the same for every session on the host on every batch. The mark moves
   * forward as events ship and is dropped whenever the file is rewritten.
   */
  private readonly resume = new Map<
    string,
    { afterSeq: number; offset: number }
  >();
  private readonly bodyIndexes: BodyIndexStore;
  /**
   * Event and body files written since the last `flush`, so a group commit
   * covers exactly what a tick or a drain touched rather than every file the
   * WAL has ever opened. See `flush` for why this exists.
   */
  private readonly dirtyPaths = new Set<string>();

  constructor(
    dir: string,
    private readonly reportBodyFailure: (failure: WalBodyFailure) => void = (
      failure,
    ) => console.warn("WAL body unavailable", failure),
    private readonly reportChainGap: (gap: WalChainGap) => void = (gap) =>
      console.warn("WAL chain gap", gap),
    private readonly reportEventParseFailure: (
      failure: WalEventParseFailure,
    ) => void = (failure) =>
      console.warn("WAL event line unparseable", failure),
  ) {
    this.dir = dir;
    ensureDir(dir);
    this.bodyIndexes = new BodyIndexStore(dir);
    this.cursorPath = join(dir, "cursor.json");
    const raw = readJsonFileIfExists(this.cursorPath) as
      | Partial<Cursor>
      | undefined;
    this.cursor = {
      shipped: raw?.shipped ?? {},
      sealed: raw?.sealed ?? {},
    };
  }

  private fileFor(sessionUuid: string): string {
    return join(this.dir, `${sessionUuid}.ndjson`);
  }

  private bodyFileFor(sessionUuid: string): string {
    return join(this.dir, `${sessionUuid}.bodies.jsonl`);
  }

  private persistCursor(): void {
    // Commit the WAL bytes this cursor answers for before the cursor itself
    // lands. `shipped` and `sealed` are read back as claims about what the
    // event and body files durably hold; writing the claim first and the
    // bytes later is the ordering that lets a crash leave the two disagreeing.
    this.flush();
    writeSensitiveFileAtomic(this.cursorPath, JSON.stringify(this.cursor));
  }

  /**
   * Durably commit every WAL event and body file written since the last
   * flush.
   *
   * `appendFileSync` returns once the write syscall completes, which is
   * before the bytes are guaranteed to survive a crash: they can sit in the
   * page cache indefinitely. An `fsync` per event would cost every append a
   * disk round trip, so this is a group commit instead — one flush covers
   * every session a tick or a drain touched, called by `persistCursor` (this
   * file's own shipped/sealed bookkeeping) and by the daemon immediately
   * before it persists the recorder state that answers for the same bytes.
   */
  flush(): void {
    if (this.dirtyPaths.size === 0) return;
    const paths = [...this.dirtyPaths];
    this.dirtyPaths.clear();
    for (const path of paths) {
      let fd: number;
      try {
        fd = openSync(path, "r+");
      } catch (error) {
        // Gone since it was marked dirty (compacted, rewritten): nothing to
        // commit, not a durability failure.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          console.warn("WAL flush could not open file", {
            path,
            error: error instanceof Error ? error.message : String(error),
          });
        continue;
      }
      try {
        fdatasyncSync(fd);
      } catch (error) {
        console.warn("WAL flush failed", {
          path,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        closeSync(fd);
      }
    }
  }

  /** Write these bodies to their sessions' body files, one line each. */
  private writeBodies(bodies: readonly FrameBody[]): void {
    const bodyLines = new Map<string, string[]>();
    for (const body of bodies) {
      const lines = bodyLines.get(body.session_uuid) ?? [];
      const stored: StoredBody = {
        event_id_idem: body.event_id_idem,
        seq: body.seq,
        content_type: body.content_type,
        bytes_base64: Buffer.from(body.bytes).toString("base64"),
      };
      lines.push(JSON.stringify(stored));
      bodyLines.set(body.session_uuid, lines);
    }
    for (const [session, lines] of bodyLines) {
      const path = this.bodyFileFor(session);
      try {
        // Separate a prior torn tail from this batch, including after restart.
        appendFileSync(path, `\n${lines.join("\n")}\n`, {
          mode: 0o600,
        });
        this.dirtyPaths.add(path);
      } catch (error) {
        this.bodyFailure(session, "append", error);
        // ENOSPC and friends must not be swallowed here: the event this
        // body belongs to is sealed already, and a caller that thinks the
        // body landed when it did not has nothing left to roll back once
        // the event write below succeeds. Throwing lets the daemon's
        // mark/seal/append/rollback helper undo the seal too.
        throw error;
      }
    }
  }

  /**
   * Bodies this session's body file already stores, by event id.
   *
   * Read from the sidecar index, which holds one entry per stored body and is
   * extended rather than rebuilt as the file grows, so the answer costs the
   * lines appended since the last read. An index that cannot be built answers
   * with nothing, which writes a body twice rather than losing it.
   */
  private storedBodyIdems(sessionUuid: string): ReadonlySet<string> {
    const path = this.bodyFileFor(sessionUuid);
    if (!existsSync(path)) return new Set();
    try {
      const index = this.bodyIndexes.ensure(
        sessionUuid,
        path,
        () => this.reportInvalidBody(sessionUuid),
        (error) => this.bodyFailure(sessionUuid, "read", error),
      );
      return new Set(index.entries.keys());
    } catch (error) {
      this.bodyFailure(sessionUuid, "read", error);
      return new Set();
    }
  }

  /**
   * Bodies are written after the seq check and before the events, so ordinary
   * writes ship content with its event. A failed body write throws (see
   * `writeBodies`), so the sealed event this call was asked to persist
   * alongside it never reaches the file either: the caller's
   * mark/seal/append/rollback helper undoes the seal in memory to match,
   * rather than leaving a recorder cursor ahead of a chain the WAL never
   * durably held.
   *
   * A call is all or nothing across every file it touches. When any write
   * throws, each event and body file the call wrote is cut back to its size
   * before the call, and a file the call created is removed. Each session's
   * `lastSeq` and `cursor.sealed` entry go back to what they held. Every
   * caller rolls back each chain it marked when `append` throws, so an event
   * file left holding one session's events stood ahead of that session's
   * rolled-back recorder, and the seq guard below refused every later write
   * for it (#4311). A body left behind was served in place of the next
   * event's own, because the rolled-back seal hands the same seq, and so the
   * same `event_id_idem`, to that event, and ingest refused it as a digest
   * mismatch (#3372). A crash between the two writes can still leave an
   * orphan, and the daemon cuts it at its next startup (`repairOrphanBodies`),
   * before any event takes its seq.
   *
   * Every event is also checked against this session's last known seq
   * before anything is written. A seq at or behind it is refused rather than
   * appended: a restart that restored a stale cursor, or a retry racing the
   * write it is retrying, would otherwise land a second event at a seq the
   * file already holds, which is exactly what let a ClickHouse
   * `ReplacingMergeTree` keyed on seq silently keep the newer, wrong frame
   * over the original.
   */
  append(
    events: readonly TachoEvent[],
    bodies: readonly FrameBody[] = [],
  ): void {
    const bySession = new Map<string, string[]>();
    // What each touched session's bookkeeping held before this call, so a
    // throw (a stale seq caught below, or a write that fails further down)
    // puts back exactly what it found. Left advanced, `lastSeq` made the seq
    // guard refuse the caller's retry of the same batch.
    const priorLastSeq = new Map<string, number | undefined>();
    const priorSealed = new Map<string, string | undefined>();
    let eventMarks = new Map<string, number | undefined>();
    let bodyMarks = new Map<string, number | undefined>();
    try {
      for (const event of events) {
        if (!priorLastSeq.has(event.session_uuid)) {
          priorLastSeq.set(
            event.session_uuid,
            this.lastSeq.get(event.session_uuid),
          );
          priorSealed.set(
            event.session_uuid,
            this.cursor.sealed[event.session_uuid],
          );
        }
        const lines = bySession.get(event.session_uuid) ?? [];
        lines.push(JSON.stringify(event));
        bySession.set(event.session_uuid, lines);
        if (
          lines.length === 1 &&
          !this.lastSeq.has(event.session_uuid) &&
          !existsSync(this.fileFor(event.session_uuid))
        ) {
          // A session this write creates: its file will hold exactly these
          // events, so the last seq is known without a read.
          this.lastSeq.set(event.session_uuid, event.seq - 1);
        }
        // A session this process has not touched yet, but whose file already
        // exists, falls back to `lastSeqOf`, which reads the file once
        // and caches the answer. Without this fallback `known` stayed
        // `undefined` for exactly the restart case the seq guard below
        // exists to catch.
        const known =
          this.lastSeq.get(event.session_uuid) ??
          this.lastSeqOf(event.session_uuid);
        if (event.seq <= known) {
          throw new Error(
            `WAL append refused for session ${event.session_uuid}: seq ${event.seq} is not after the last written seq ${known}`,
          );
        }
        if (event.seq > known + 1) {
          // The control plane refuses this chain from here on. Say so at
          // the moment of writing, on this machine, rather than only in the
          // ingest response the daemon cannot act on.
          this.reportChainGap({
            session_uuid: event.session_uuid,
            after_seq: known,
            seq: event.seq,
            kind: event.kind,
          });
        }
        this.lastSeq.set(event.session_uuid, event.seq);
        if (event.kind === "agent_stop") {
          this.cursor.sealed[event.session_uuid] = event.ts;
        }
      }
      // After the seq check, so a refused batch writes nothing.
      eventMarks = this.fileSizes(bySession.keys(), (session) =>
        this.fileFor(session),
      );
      bodyMarks = this.fileSizes(
        bodies.map((body) => body.session_uuid),
        (session) => this.bodyFileFor(session),
      );
      this.writeBodies(bodies);
      for (const [session, lines] of bySession) {
        const path = this.fileFor(session);
        appendFileSync(path, `${lines.join("\n")}\n`, { mode: 0o600 });
        this.dirtyPaths.add(path);
      }
    } catch (error) {
      // The failing write can be partial (ENOSPC mid-buffer, most often), so
      // its own file is cut back with the rest rather than left holding a
      // torn line for the next read to trip over.
      this.cutBack(
        eventMarks,
        (session) => this.fileFor(session),
        // A failed cut leaves at most a stray tail, which the next startup's
        // `repairTail` cleans up.
        () => undefined,
      );
      this.cutBack(
        bodyMarks,
        (session) => this.bodyFileFor(session),
        // An orphan left here is cut at the next startup
        // (`repairOrphanBodies`). Until then the index keeps the last line
        // for an event id (`wal-index.ts`), so a later body for the same id
        // is the one served.
        (session, error) => this.bodyFailure(session, "cleanup", error),
      );
      for (const session of bySession.keys()) {
        const prior = priorLastSeq.get(session);
        if (prior === undefined) this.lastSeq.delete(session);
        else this.lastSeq.set(session, prior);
        const priorSeal = priorSealed.get(session);
        if (priorSeal === undefined) delete this.cursor.sealed[session];
        else this.cursor.sealed[session] = priorSeal;
      }
      throw error;
    }
    if (events.some((event) => event.kind === "agent_stop")) {
      this.persistCursor();
    }
  }

  /** Each session's file size before a write, or undefined when it has none. */
  private fileSizes(
    sessions: Iterable<string>,
    pathOf: (session: string) => string,
  ): Map<string, number | undefined> {
    const sizes = new Map<string, number | undefined>();
    for (const session of sessions) {
      if (sizes.has(session)) continue;
      const path = pathOf(session);
      sizes.set(session, existsSync(path) ? statSync(path).size : undefined);
    }
    return sizes;
  }

  /**
   * Put each file a failed `append` touched back to its size before the call,
   * and remove one the call created. A session file left empty would still
   * count as on disk for `sessions()`, which the daemon's rollback reads to
   * decide whether a chain it never marked is new.
   */
  private cutBack(
    marks: ReadonlyMap<string, number | undefined>,
    pathOf: (session: string) => string,
    onFailure: (session: string, error: unknown) => void,
  ): void {
    for (const [session, size] of marks) {
      const path = pathOf(session);
      try {
        if (!existsSync(path)) continue;
        if (size === undefined) unlinkSync(path);
        else if (statSync(path).size !== size) truncateSync(path, size);
      } catch (error) {
        // The append already failed, and its error is the one the caller
        // gets.
        onFailure(session, error);
      }
    }
  }

  /**
   * Retry a journaled terminal batch without duplicating what is already
   * durable, on both files.
   *
   * The events were already deduplicated against the session's chain. The
   * bodies were not, so a batch retried after its first append wrote its
   * content a second time, and a batch retried on every restart wrote it
   * again on every restart. The journal is a hand-off and the body file is the
   * store, so a body the store already holds is not written again. Identity is
   * the event id, which is what `bodiesFor` reads a body back by and what the
   * retention sweeps name one by.
   */
  appendRecovered(
    events: readonly TachoEvent[],
    bodies: readonly FrameBody[] = [],
  ): void {
    const durable = new Map<string, Map<number, TachoEvent>>();
    const missing: TachoEvent[] = [];
    for (const event of events) {
      let rows = durable.get(event.session_uuid);
      if (!rows) {
        const path = this.fileFor(event.session_uuid);
        if (existsSync(path)) {
          const bytes = readFileSync(path);
          if (bytes.length > 0 && bytes[bytes.length - 1] !== 10) {
            const boundary = bytes.lastIndexOf(10) + 1;
            let complete = false;
            try {
              JSON.parse(bytes.subarray(boundary).toString("utf8"));
              complete = true;
            } catch {
              /* A torn final line is replaced from the durable journal. */
            }
            if (complete) appendFileSync(path, "\n");
            else truncateSync(path, boundary);
          }
        }
        rows = new Map(
          this.read(event.session_uuid).map((row) => [row.seq, row]),
        );
        durable.set(event.session_uuid, rows);
      }
      const prior = rows.get(event.seq);
      if (!prior) missing.push(event);
      else if (
        prior.hash !== event.hash ||
        prior.event_id_idem !== event.event_id_idem
      )
        throw new WalRecoveryConflict(event.session_uuid, event.seq);
    }
    // A recovery can truncate a torn tail, which moves the bytes after it.
    for (const event of events) this.resume.delete(event.session_uuid);
    const stored = new Map<string, ReadonlySet<string>>();
    const fresh = bodies.filter((body) => {
      let held = stored.get(body.session_uuid);
      if (held === undefined) {
        held = this.storedBodyIdems(body.session_uuid);
        stored.set(body.session_uuid, held);
      }
      return !held.has(body.event_id_idem);
    });
    this.append(missing, fresh);
    // The event write can succeed before the cursor file fails. Rebuild that
    // metadata on retry even when every event was already durable.
    for (const event of events)
      if (event.kind === "agent_stop")
        this.cursor.sealed[event.session_uuid] = event.ts;
    this.persistCursor();
  }

  private bodyFailure(
    session: string,
    operation: WalBodyFailure["operation"],
    error: unknown,
  ): void {
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string" &&
      /^[A-Za-z0-9_]+$/.test(error.code)
        ? error.code
        : "body_io_failed";
    try {
      this.reportBodyFailure({ session_uuid: session, operation, code });
    } catch {
      // A sink that throws must not change what the caller does next. A
      // failed body append still throws its own error, not the sink's
      // (ADR-185).
    }
  }

  sessions(): string[] {
    return readdirSync(this.dir)
      .filter((name) => name.endsWith(".ndjson"))
      .map((name) => name.slice(0, -".ndjson".length))
      .sort();
  }

  /**
   * Every event of one session, in seq order.
   *
   * A line that will not parse is reported and skipped rather than thrown:
   * one torn write (a crash mid-append, before `repairTail` runs at the next
   * startup) must not stop every reader of this session. `head`, `compact`,
   * `lastSeqOf`, `appendRecovered`, and the retention sweep read through
   * here. `unshipped` and `stats` read through `eventsAfterShipped`, which
   * skips a bad line the same way.
   */
  read(sessionUuid: string): TachoEvent[] {
    const path = this.fileFor(sessionUuid);
    if (!existsSync(path)) return [];
    const out: TachoEvent[] = [];
    for (const line of readLinesFrom(path)) {
      if (line.text.trim().length === 0) continue;
      try {
        out.push(JSON.parse(line.text) as TachoEvent);
      } catch (error) {
        this.reportEventParseFailure({
          session_uuid: sessionUuid,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return out;
  }

  /** The event ids each session in this batch is asked for. */
  private static idemsBySession(
    events: readonly TachoEvent[],
  ): Map<string, Set<string>> {
    const wanted = new Map<string, Set<string>>();
    for (const event of events) {
      const idems = wanted.get(event.session_uuid) ?? new Set<string>();
      idems.add(event.event_id_idem);
      wanted.set(event.session_uuid, idems);
    }
    return wanted;
  }

  private reportInvalidBody(session: string): void {
    this.bodyFailure(session, "read", { code: "invalid_body_record" });
  }

  /**
   * One session's bodies, read at the offsets its index gives.
   *
   * An index that does not describe the file it indexes is thrown away and
   * built again, once. The file is the record and the index is a cache, so a
   * disagreement between them is answered by trusting the file. A second
   * disagreement is reported and the bodies are left out: the events still
   * ship, and the control plane records the frames with a `body_missing` gap,
   * which is what a lost body has always meant here.
   */
  private bodiesOfSession(
    session: string,
    path: string,
    idems: ReadonlySet<string>,
  ): Map<string, TachoBody> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const index = this.bodyIndexes.ensure(
        session,
        path,
        () => this.reportInvalidBody(session),
        (error) => this.bodyFailure(session, "read", error),
      );
      const found = new Map<string, TachoBody>();
      let stale = false;
      const fd = openSync(path, "r");
      try {
        for (const idem of idems) {
          const at = index.entries.get(idem);
          if (at === undefined) continue;
          const buffer = Buffer.allocUnsafe(at.length);
          let filled = 0;
          while (filled < at.length) {
            const size = readSync(
              fd,
              buffer,
              filled,
              at.length - filled,
              at.offset + filled,
            );
            if (size <= 0) break;
            filled += size;
          }
          const stored =
            filled === at.length
              ? parseStoredBody(buffer.toString("utf8"))
              : undefined;
          if (stored === undefined || stored.event_id_idem !== idem) {
            stale = true;
            break;
          }
          found.set(idem, {
            event_id_idem: stored.event_id_idem,
            content_type: stored.content_type,
            bytes_base64: stored.bytes_base64,
          });
        }
      } finally {
        closeSync(fd);
      }
      if (!stale) return found;
      this.bodyIndexes.invalidate(session);
    }
    this.bodyFailure(session, "read", { code: "body_index_unusable" });
    return new Map();
  }

  /**
   * The wire bodies of the given events, in the events' order, at most one
   * per event. Each session's bodies are read at the offsets its index holds,
   * so the read costs the batch rather than the session.
   */
  bodiesFor(events: readonly TachoEvent[]): TachoBody[] {
    const found = new Map<string, TachoBody>();
    for (const [session, idems] of Wal.idemsBySession(events)) {
      const path = this.bodyFileFor(session);
      if (!existsSync(path)) continue;
      try {
        for (const [idem, body] of this.bodiesOfSession(session, path, idems))
          found.set(idem, body);
      } catch (error) {
        this.bodyFailure(session, "read", error);
        throw error;
      }
    }
    const out: TachoBody[] = [];
    for (const event of events) {
      const body = found.get(event.event_id_idem);
      if (body !== undefined) out.push(body);
    }
    return out;
  }

  /**
   * The same bodies, read without holding the event loop.
   *
   * Two things here are not on the synchronous path. Indexing a body file the
   * host already had costs one walk of it, and that walk awaits every read.
   * The batch is then read in slices with a turn of the loop between them, so
   * a `/status` request or a control-plane fetch waits for one slice.
   *
   * The slices go through `bodiesFor`, which is the one place a body is read
   * and the one place a read failure is reported, so both paths fail the same
   * way and the shipper has a single error to handle.
   */
  async bodiesForAsync(events: readonly TachoEvent[]): Promise<TachoBody[]> {
    for (const session of Wal.idemsBySession(events).keys()) {
      const path = this.bodyFileFor(session);
      if (!existsSync(path)) continue;
      try {
        await this.bodyIndexes.ensureAsync(
          session,
          path,
          () => this.reportInvalidBody(session),
          (error) => this.bodyFailure(session, "read", error),
        );
      } catch (error) {
        this.bodyFailure(session, "read", error);
        throw error;
      }
    }
    const out: TachoBody[] = [];
    for (let at = 0; at < events.length; at += BODY_READ_SLICE) {
      if (at > 0) await new Promise((resolve) => setImmediate(resolve));
      out.push(...this.bodiesFor(events.slice(at, at + BODY_READ_SLICE)));
    }
    return out;
  }

  /**
   * Delete the stored bytes of these events' bodies, and report how many
   * lines went.
   *
   * A mandate that narrows has to reach what is already on disk, not only
   * what is about to leave (`docs/specs/gateway/spec.md`). Omitting a body
   * from the outgoing request protects the network boundary and nothing
   * else: `markShipped` only advances a cursor, and `compact` removes body
   * bytes only once a sealed session has aged out, so an unsealed session
   * would hold the withdrawn prompt or tool content indefinitely.
   *
   * The event line is untouched. The chain is the record, and only the
   * content is withdrawn; a frame whose body is gone still hashes and still
   * ships.
   *
   * A rewrite is safe because this file has exactly one writer: `append` is
   * reached only from the daemon's own recording path, and a hook running
   * while the daemon is down leaves its work in the inbox rather than writing
   * here. A body file with a second writer would need a tombstone instead,
   * because a read-filter-rename loses a line appended between the read and
   * the rename.
   */
  dropBodies(events: readonly TachoEvent[]): number {
    const wanted = new Map<string, Set<string>>();
    for (const event of events) {
      const idems = wanted.get(event.session_uuid) ?? new Set<string>();
      idems.add(event.event_id_idem);
      wanted.set(event.session_uuid, idems);
    }
    let dropped = 0;
    for (const [session, idems] of wanted) {
      dropped += this.rewriteBodies(
        session,
        (stored) => stored !== undefined && !idems.has(stored.event_id_idem),
      );
    }
    return dropped;
  }

  /** Sessions that have a body file, whether or not they have an event file. */
  private sessionsWithBodies(): string[] {
    const suffix = ".bodies.jsonl";
    return readdirSync(this.dir)
      .filter((name) => name.endsWith(suffix))
      .map((name) => name.slice(0, -suffix.length));
  }

  /** The last sealed event of a session, if any. */
  head(sessionUuid: string): TachoEvent | undefined {
    const events = this.read(sessionUuid);
    return events[events.length - 1];
  }

  /**
   * The last sealed event of a session, read from the tail of its file
   * rather than by parsing every line `head` does.
   *
   * Used once, at daemon startup, to check a restored recorder cursor
   * against what the log actually holds before a new event is sealed on top
   * of it — see the daemon's cursor reconciliation. A session with a torn
   * last line (repaired by `repairTail` earlier in the same startup, in the
   * ordinary case) answers `undefined` here rather than a guess, since a
   * caller correcting a cursor from a bad reading is worse than one that
   * found nothing to correct with.
   */
  lastEvent(sessionUuid: string): TachoEvent | undefined {
    const path = this.fileFor(sessionUuid);
    if (!existsSync(path)) return undefined;
    const line = readTailLine(path);
    if (line === undefined || !line.terminated || line.text.trim().length === 0)
      return undefined;
    try {
      return JSON.parse(line.text) as TachoEvent;
    } catch (error) {
      this.reportEventParseFailure({
        session_uuid: sessionUuid,
        reason: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /**
   * Repair one session's event file if its last line is torn: a write that
   * landed content but never the newline that closes it, most often because
   * the process died mid-`appendFileSync`.
   *
   * Only the daemon calls this, once at startup, and never from this file's
   * own constructor: a reader building a `Wal` for `tacho status` or `tacho
   * export` must never rewrite a file the daemon might still be writing to,
   * which is why every reader here already tolerates a torn trailing line
   * instead of throwing on it (`read`, `eventsAfterShipped`). This is what
   * turns that tolerance into "nothing left to tolerate" on the next read: a
   * line that parses once completed is closed with the newline it was
   * missing, and a line that will never parse (torn mid-write) is cut away
   * entirely, since nothing durable was lost by a write that never finished.
   */
  repairTail(sessionUuid: string): "ok" | "terminated" | "truncated" {
    const path = this.fileFor(sessionUuid);
    if (!existsSync(path)) return "ok";
    const line = readTailLine(path);
    if (line === undefined || line.terminated) return "ok";
    const complete =
      line.text.trim().length > 0 &&
      (() => {
        try {
          JSON.parse(line.text);
          return true;
        } catch {
          return false;
        }
      })();
    if (complete) {
      appendFileSync(path, "\n");
      this.dirtyPaths.add(path);
      return "terminated";
    }
    truncateSync(path, line.offset);
    this.lastSeq.delete(sessionUuid);
    this.resume.delete(sessionUuid);
    this.dirtyPaths.add(path);
    return "truncated";
  }

  /**
   * Cut the bodies a crash left with no event from the tail of every body
   * file, and report how many lines went.
   *
   * `append` writes a batch's bodies just before its events. A process that
   * dies between the two writes leaves bodies with no event. The restarted
   * recorder takes its cursor from the event file, so the next event gets
   * the same seq and the same `event_id_idem`. When that event wrote no body
   * of its own, `bodiesFor` served the orphan for it, and ingest refused it.
   * Retention kept the orphan too, because `keeps` holds any body whose event
   * id is on the chain, and the later event put it there (#3372).
   *
   * Only the batch in flight can be caught between the two writes, so a crash
   * orphan is always at the end of its file: a line whose seq is past the
   * session's last event, or a line torn part way. The walk reads back from
   * the end one line at a time and stops at the first body whose event is on
   * disk, so it costs the orphans rather than the file. A body file with no
   * event file beside it is all orphans, and it goes.
   *
   * Only the daemon calls this, once at startup after `repairTail`, for the
   * reason `repairTail` gives.
   */
  repairOrphanBodies(): number {
    let cut = 0;
    for (const session of this.sessionsWithBodies()) {
      try {
        cut += this.cutOrphanBodies(session);
      } catch (error) {
        this.bodyFailure(session, "cleanup", error);
      }
    }
    return cut;
  }

  private cutOrphanBodies(sessionUuid: string): number {
    const lastSeq = this.lastWrittenSeq(sessionUuid);
    // A tail that cannot be read says nothing about which bodies are orphans.
    if (lastSeq === undefined) return 0;
    const path = this.bodyFileFor(sessionUuid);
    const size = statSync(path).size;
    let keep = size;
    let cut = 0;
    while (keep > 0) {
      const line = readTailLine(path, keep);
      // What is left is one newline.
      if (line === undefined) {
        keep = 0;
        break;
      }
      if (line.text.trim().length > 0) {
        const stored = parseStoredBody(line.text);
        // A whole line that is not a body was not torn by a crash, so it stays.
        if (stored === undefined ? line.terminated : stored.seq <= lastSeq)
          break;
        cut += 1;
      }
      keep = line.offset;
    }
    // Blank lines alone are batch separators, not orphans.
    if (cut === 0) return 0;
    if (keep === 0) unlinkSync(path);
    else {
      truncateSync(path, keep);
      this.dirtyPaths.add(path);
    }
    // Offsets past the cut describe bytes that are gone.
    this.bodyIndexes.invalidate(sessionUuid);
    return cut;
  }

  /**
   * The seq of the last event in a session's file, read from its tail: -1
   * when the session has no event on disk, undefined when the tail does not
   * parse.
   */
  private lastWrittenSeq(sessionUuid: string): number | undefined {
    const path = this.fileFor(sessionUuid);
    if (!existsSync(path) || statSync(path).size === 0) return -1;
    return this.lastEvent(sessionUuid)?.seq;
  }

  /** The highest seq in a session's file, or -1 when it holds none. */
  private lastSeqOf(sessionUuid: string): number {
    const known = this.lastSeq.get(sessionUuid);
    if (known !== undefined) return known;
    let last = -1;
    for (const event of this.read(sessionUuid))
      if (event.seq > last) last = event.seq;
    this.lastSeq.set(sessionUuid, last);
    return last;
  }

  /** Whether a session's file holds an event past its shipped cursor. */
  private hasUnshipped(sessionUuid: string): boolean {
    return this.lastSeqOf(sessionUuid) > this.shippedThrough(sessionUuid);
  }

  shippedThrough(sessionUuid: string): number {
    return this.cursor.shipped[sessionUuid] ?? -1;
  }

  /**
   * One session's events past its shipped cursor, in seq order.
   *
   * The walk starts at the byte the last walk left the cursor on, so it reads
   * the events that have not shipped rather than the ones that have. The mark
   * is only ever set on a line a newline closed, because an unterminated tail
   * is joined by the next append and reading past it would skip the joined
   * line instead of failing on it.
   */
  private *eventsAfterShipped(sessionUuid: string): Generator<TachoEvent> {
    const path = this.fileFor(sessionUuid);
    if (!existsSync(path)) return;
    const through = this.shippedThrough(sessionUuid);
    const mark = this.resume.get(sessionUuid);
    const from =
      mark !== undefined && mark.afterSeq <= through ? mark.offset : 0;
    for (const line of readLinesFrom(path, from)) {
      if (line.text.trim().length === 0) continue;
      let event: TachoEvent;
      try {
        event = JSON.parse(line.text) as TachoEvent;
      } catch (error) {
        // Reported and skipped, not thrown: a shipper mid-drain must not
        // stop on the one line a crash tore, and the resume mark is left
        // where it was so the next walk tries this line again rather than
        // silently stepping over it.
        this.reportEventParseFailure({
          session_uuid: sessionUuid,
          reason: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (event.seq > through) {
        yield event;
        continue;
      }
      if (line.terminated)
        this.resume.set(sessionUuid, { afterSeq: event.seq, offset: line.end });
    }
  }

  /** Up to `limit` unshipped events, grouped by session in seq order. */
  unshipped(
    limit: number,
    excludedSessions: ReadonlySet<string> = new Set(),
  ): TachoEvent[] {
    const out: TachoEvent[] = [];
    for (const session of this.sessions()) {
      if (excludedSessions.has(session) || !this.hasUnshipped(session))
        continue;
      for (const event of this.eventsAfterShipped(session)) {
        out.push(event);
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  markShipped(sessionUuid: string, throughSeq: number): void {
    if (throughSeq <= this.shippedThrough(sessionUuid)) return;
    this.cursor.shipped[sessionUuid] = throughSeq;
    this.persistCursor();
  }

  /**
   * How many events, sessions, and hosts a call to `health()` or `/status`
   * answers with, without paying to parse them.
   *
   * `stats` used to answer this by reading every unshipped event of every
   * session and counting them, which the Shipper's own `sendBatch` asks for
   * on every batch — so a 45,000-event backlog draining at 200 events a
   * batch cost roughly 45,000 x 225 event reads across one drain, quadratic
   * in the backlog rather than linear. The count is now arithmetic —
   * `lastSeqOf - shippedThrough`, which a dense chain (the ordinary case)
   * answers exactly — and the one thing arithmetic cannot answer,
   * `oldestUnshippedAt`, costs reading a single event per session with
   * anything unshipped, not the whole tail. A session with an actual gap
   * (already reported through `reportChainGap` when it was written) can
   * undercount here; that is the cost of a status figure no longer costing
   * the backlog it describes.
   */
  stats(): WalStats {
    let unshipped = 0;
    let oldest: string | undefined;
    const sessions = this.sessions();
    for (const session of sessions) {
      const last = this.lastSeqOf(session);
      const through = this.shippedThrough(session);
      if (last <= through) continue;
      unshipped += last - through;
      const first = this.eventsAfterShipped(session).next();
      if (!first.done && (oldest === undefined || first.value.ts < oldest))
        oldest = first.value.ts;
    }
    return {
      sessions: sessions.length,
      unshipped,
      ...(oldest !== undefined ? { oldestUnshippedAt: oldest } : {}),
    };
  }

  /**
   * Erase every stored body whose class `retention` does not cover, in every
   * session this host holds, and answer how many were erased.
   *
   * Why this exists beside `dropBodies`. `dropBodies` reaches the bodies of
   * the events in a drain's batch, which is every body the shipper still has
   * an unshipped event for. Two kinds of body sit outside that reach: one
   * whose event already shipped, since `markShipped` advanced the cursor past
   * it, and one in a session the drain is not looking at. `compact` frees
   * those only once their session is sealed, fully shipped, and older than
   * the retention window, so a session that never seals kept them for as long
   * as the host ran, or for ever on a host that never came back. This sweep
   * walks every session and every stored line, so a narrowing reaches all of
   * them.
   *
   * The write is the one in `rewriteBodies`, which `dropBodies` uses as well:
   * atomic, and safe because these files have one writer. The module header
   * establishes that.
   *
   * Erasing is not reversible. A workspace that narrows its mandate and then
   * widens it again does not get these bodies back: the host holds no copy,
   * and neither does the control plane for anything it had not already
   * accepted. Widening applies to frames sealed after it, and the sessions
   * that ran under the narrower mandate keep their digests and carry a
   * `body_missing` gap for the content. Callers must not offer a mandate they
   * cannot stand behind.
   *
   * The caller decides when to call this, and the condition is not the one
   * that withholds a body from a shipment. See `purgeBodiesNarrowedOut` in
   * the daemon, which calls this when a replacement bundle verifies and
   * narrows the clause.
   */
  purgeBodiesOutsideMandate(retention: RetentionMandate): number {
    let purged = 0;
    // Every session that has an event file OR a body file. `sessions()` lists
    // `.ndjson` only, so a crash between `append`'s body write and its first
    // event write leaves a `<uuid>.bodies.jsonl` with no `.ndjson` beside it —
    // invisible to this sweep and to `compact`, which also walks `sessions()`.
    // Those bytes would outlive every mechanism meant to remove them.
    const sessions = new Set([
      ...this.sessions(),
      ...this.sessionsWithBodies(),
    ]);
    for (const session of sessions) {
      if (!existsSync(this.bodyFileFor(session))) continue;
      const kindOf = new Map(
        this.read(session).map(
          (event) => [event.event_id_idem, event.kind] as const,
        ),
      );
      purged += this.rewriteBodies(session, (stored) =>
        this.keeps(stored, kindOf, retention),
      );
    }
    return purged;
  }

  /**
   * Whether one stored body survives this mandate. Three answers, each for a
   * reason:
   *
   * - A line that does not parse names no event, so nothing can ever ship it.
   *   A crash part way through an append leaves exactly this, with content in
   *   it, and keeping it would keep content under no mandate at all. The
   *   rewrite reports it as `undefined`.
   * - A body whose event is not on the session's chain goes. `append` writes
   *   bodies before events on purpose, and that window is real — but it is
   *   not observable from here. `append` is synchronous end to end, two
   *   `appendFileSync` calls with no await between them, and the daemon is
   *   single threaded, so no sweep can run inside it. A body with no event
   *   at sweep time is therefore a crash orphan: the process died between
   *   the two writes and no event will ever arrive for it. Keeping it kept
   *   prompt or tool bytes that no mandate covers and that nothing would
   *   ever ship, delete or compact, because every one of those paths starts
   *   from the event.
   * - Otherwise the class comes from the event's kind and the one retention
   *   gate answers. A kind the table does not name has no class, so no mandate
   *   can cover it and the body goes.
   */
  private keeps(
    stored: StoredBody | undefined,
    kindOf: ReadonlyMap<string, string>,
    retention: RetentionMandate,
  ): boolean {
    if (stored === undefined) return false;
    const kind = kindOf.get(stored.event_id_idem);
    if (kind === undefined) return false;
    const contentClass = contentClassOf(kind);
    if (contentClass === undefined) return false;
    return retentionAllows(retention, contentClass);
  }

  /**
   * Rewrite one session's body file, keeping the lines `keep` answers true
   * for, and report how many went. The file is removed when nothing is left,
   * so a session that loses every body loses the file too.
   *
   * This is the one place body bytes are rewritten. `dropBodies` names the
   * bodies of a batch and `purgeBodiesOutsideMandate` sweeps a whole session,
   * and both come through here, so there is one mechanism to reason about.
   * The write is atomic, through a temporary file and a rename, so a crash
   * part way cannot leave a torn file. It is safe against nothing else: with a
   * second writer, a line appended between the read and the rename would be
   * lost, and the module header is where the single writer is established.
   *
   * A line that is not a stored body is handed to `keep` as `undefined`,
   * rather than throwing. A torn line is what a crash mid-append leaves, and a
   * sweep that threw on one would stop erasing the content around it. A line
   * that parses as JSON but names no event is the same case and gets the same
   * answer, because nothing can ever ship it.
   */
  private rewriteBodies(
    sessionUuid: string,
    keep: (stored: StoredBody | undefined) => boolean,
  ): number {
    const path = this.bodyFileFor(sessionUuid);
    if (!existsSync(path)) return 0;
    const tmp = `${path}.${randomUUID()}.tmp`;
    const fd = openSync(tmp, "wx", 0o600);
    let cut = 0;
    let kept = 0;
    try {
      try {
        for (const line of readLinesFrom(path)) {
          if (line.text.trim().length === 0) continue;
          const stored = parseStoredBody(line.text);
          if (keep(stored)) {
            const bytes = Buffer.from(`${line.text}\n`);
            let offset = 0;
            while (offset < bytes.length) {
              offset += writeSync(fd, bytes, offset, bytes.length - offset);
            }
            kept += 1;
          } else cut += 1;
        }
        if (cut > 0 && kept > 0) fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      if (cut === 0) return 0;
      if (kept === 0) unlinkSync(path);
      else renameSync(tmp, path);
      // Every surviving line moved, so the offsets no longer describe the file.
      this.bodyIndexes.invalidate(sessionUuid);
      return cut;
    } finally {
      if (existsSync(tmp)) unlinkSync(tmp);
    }
  }

  /**
   * Remove session files that are sealed, fully shipped, and older than
   * `retainMs`. The control plane holds the record; the host keeps a window
   * for `tacho export` and incident review.
   */
  compact(now: number, retainMs: number): string[] {
    // Only the daemon compacts. Rewrites and this scan are synchronous under
    // its single-writer ownership, so no live rewrite can overlap the scan.
    // Readers (status and export) construct a Wal too and must not clean here.
    // Report each unlink failure and keep compacting unrelated evidence.
    const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
    const abandonedRewrite = new RegExp(
      `^${uuid}\\.bodies\\.jsonl\\.${uuid}\\.tmp$`,
    );
    for (const name of readdirSync(this.dir)) {
      if (abandonedRewrite.test(name)) {
        try {
          unlinkSync(join(this.dir, name));
        } catch (error) {
          this.bodyFailure(name.slice(0, 36), "cleanup", error);
        }
      }
    }
    const removed: string[] = [];
    for (const session of this.sessions()) {
      const sealedAt = this.cursor.sealed[session];
      if (sealedAt === undefined) continue;
      const head = this.head(session);
      if (head === undefined || head.seq > this.shippedThrough(session))
        continue;
      const age =
        now -
        Math.max(Date.parse(sealedAt), statSync(this.fileFor(session)).mtimeMs);
      if (age < retainMs) continue;
      unlinkSync(this.fileFor(session));
      this.lastSeq.delete(session);
      this.resume.delete(session);
      if (existsSync(this.bodyFileFor(session)))
        unlinkSync(this.bodyFileFor(session));
      this.bodyIndexes.invalidate(session);
      delete this.cursor.shipped[session];
      delete this.cursor.sealed[session];
      removed.push(session);
    }
    // A body file whose session has no event file is a crash orphan: `append`
    // wrote the bodies and the process died before the first event. The loop
    // above cannot see it, because `sessions()` lists `.ndjson` only, so
    // without this the bytes outlive every removal path in this class. Aged on
    // the body file's own mtime, since there is no seal or shipped cursor to
    // measure: nothing will ever ship an event that does not exist.
    for (const session of this.sessionsWithBodies()) {
      if (existsSync(this.fileFor(session))) continue;
      const path = this.bodyFileFor(session);
      if (now - statSync(path).mtimeMs < retainMs) continue;
      unlinkSync(path);
      this.bodyIndexes.invalidate(session);
      removed.push(session);
    }
    // A sidecar whose body file has gone describes nothing. It is small, but
    // it is on the same disk the WAL is trying not to fill.
    for (const name of readdirSync(this.dir)) {
      if (!BodyIndexStore.isSidecar(name)) continue;
      const session = name.slice(0, -".bodies.index".length);
      if (existsSync(this.bodyFileFor(session))) continue;
      this.bodyIndexes.invalidate(session);
    }
    if (removed.length > 0) this.persistCursor();
    return removed;
  }
}
