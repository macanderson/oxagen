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
  type StoredBody,
} from "./wal-index";

/**
 * Events handed to `bodiesForAsync` between two turns of the event loop. Small
 * enough that one slice's reads finish in a few milliseconds, so a control
 * plane fetch or a `/status` request waits for a slice and not for a batch.
 */
const BODY_READ_SLICE = 32;

export interface WalBodyFailure {
  session_uuid: string;
  operation: "append" | "read" | "cleanup";
  code: string;
}

export interface WalStats {
  sessions: number;
  unshipped: number;
  oldestUnshippedAt?: string;
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

  constructor(
    dir: string,
    private readonly reportBodyFailure: (failure: WalBodyFailure) => void = (
      failure,
    ) => console.warn("WAL body unavailable", failure),
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
    writeSensitiveFileAtomic(this.cursorPath, JSON.stringify(this.cursor));
  }

  /**
   * Bodies go first so ordinary writes ship content with its event. A crash
   * between files can leave an orphan body, which retention sweeps remove.
   * A failed body write must still permit the sealed event to persist.
   */
  append(
    events: readonly TachoEvent[],
    bodies: readonly FrameBody[] = [],
  ): void {
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
      try {
        // Separate a prior torn tail from this batch, including after restart.
        appendFileSync(this.bodyFileFor(session), `\n${lines.join("\n")}\n`, {
          mode: 0o600,
        });
      } catch (error) {
        this.bodyFailure(session, "append", error);
      }
    }
    const bySession = new Map<string, string[]>();
    for (const event of events) {
      const lines = bySession.get(event.session_uuid) ?? [];
      lines.push(JSON.stringify(event));
      bySession.set(event.session_uuid, lines);
      const known = this.lastSeq.get(event.session_uuid);
      if (known !== undefined && event.seq > known)
        this.lastSeq.set(event.session_uuid, event.seq);
      if (event.kind === "agent_stop") {
        this.cursor.sealed[event.session_uuid] = event.ts;
      }
    }
    for (const [session, lines] of bySession) {
      appendFileSync(this.fileFor(session), `${lines.join("\n")}\n`, {
        mode: 0o600,
      });
    }
    if (events.some((event) => event.kind === "agent_stop")) {
      this.persistCursor();
    }
  }

  /** Retry a journaled terminal batch without duplicating an already durable prefix. */
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
        throw new Error(
          `WAL recovery conflict at ${event.session_uuid}:${event.seq}`,
        );
    }
    // A recovery can truncate a torn tail, which moves the bytes after it.
    for (const event of events) this.resume.delete(event.session_uuid);
    this.append(missing, bodies);
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
      // A diagnostic sink cannot prevent persistence of the sealed event.
    }
  }

  sessions(): string[] {
    return readdirSync(this.dir)
      .filter((name) => name.endsWith(".ndjson"))
      .map((name) => name.slice(0, -".ndjson".length))
      .sort();
  }

  /** Every event of one session, in seq order. */
  read(sessionUuid: string): TachoEvent[] {
    const path = this.fileFor(sessionUuid);
    if (!existsSync(path)) return [];
    const out: TachoEvent[] = [];
    for (const line of readLinesFrom(path)) {
      if (line.text.trim().length === 0) continue;
      out.push(JSON.parse(line.text) as TachoEvent);
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
      const event = JSON.parse(line.text) as TachoEvent;
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

  stats(): WalStats {
    let unshipped = 0;
    let oldest: string | undefined;
    const sessions = this.sessions();
    for (const session of sessions) {
      if (!this.hasUnshipped(session)) continue;
      for (const event of this.eventsAfterShipped(session)) {
        unshipped += 1;
        if (oldest === undefined || event.ts < oldest) oldest = event.ts;
      }
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
