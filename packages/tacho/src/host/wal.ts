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
 * are kept apart because the event file is the chain and is read whole on
 * every tick, and a body can be a megabyte; the shipped cursor covers both,
 * since a body only ever ships with its event.
 *
 * NDJSON rather than SQLite keeps the package free of native modules and lets
 * `tacho-hook` append with one syscall while the daemon is down.
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
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

/** One line of a session's body file. */
interface StoredBody {
  event_id_idem: string;
  seq: number;
  content_type: string;
  bytes_base64: string;
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

  constructor(dir: string) {
    this.dir = dir;
    ensureDir(dir);
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
   * Append sealed events, each to its own session's file, and the bodies of
   * those that carry one to the session's body file. The bodies go first:
   * a crash between the two writes then leaves an event without a body,
   * which ships as digest-only, rather than a body without an event, which
   * nothing would ever ship.
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
      appendFileSync(this.bodyFileFor(session), `${lines.join("\n")}\n`, {
        mode: 0o600,
      });
    }
    const bySession = new Map<string, string[]>();
    for (const event of events) {
      const lines = bySession.get(event.session_uuid) ?? [];
      lines.push(JSON.stringify(event));
      bySession.set(event.session_uuid, lines);
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
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (line.trim().length === 0) continue;
      out.push(JSON.parse(line) as TachoEvent);
    }
    return out;
  }

  /**
   * The wire bodies of the given events, in the events' order, at most one
   * per event. Events of one session are answered from one read of its body
   * file; a line whose event is not asked for is parsed and dropped, so a
   * session with a long shipped history costs a scan of its body file per
   * batch, the same price the event file already pays in `unshipped`.
   */
  bodiesFor(events: readonly TachoEvent[]): TachoBody[] {
    const wanted = new Map<string, Set<string>>();
    let minSeq = Number.POSITIVE_INFINITY;
    for (const event of events) {
      const idems = wanted.get(event.session_uuid) ?? new Set<string>();
      idems.add(event.event_id_idem);
      wanted.set(event.session_uuid, idems);
      if (event.seq < minSeq) minSeq = event.seq;
    }
    const found = new Map<string, TachoBody>();
    for (const [session, idems] of wanted) {
      const path = this.bodyFileFor(session);
      if (!existsSync(path)) continue;
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (line.trim().length === 0) continue;
        const stored = JSON.parse(line) as StoredBody;
        if (stored.seq < minSeq || !idems.has(stored.event_id_idem)) continue;
        if (found.has(stored.event_id_idem)) continue;
        found.set(stored.event_id_idem, {
          event_id_idem: stored.event_id_idem,
          content_type: stored.content_type,
          bytes_base64: stored.bytes_base64,
        });
      }
    }
    const out: TachoBody[] = [];
    for (const event of events) {
      const body = found.get(event.event_id_idem);
      if (body !== undefined) out.push(body);
    }
    return out;
  }

  /** The last sealed event of a session, if any. */
  head(sessionUuid: string): TachoEvent | undefined {
    const events = this.read(sessionUuid);
    return events[events.length - 1];
  }

  shippedThrough(sessionUuid: string): number {
    return this.cursor.shipped[sessionUuid] ?? -1;
  }

  /** Up to `limit` unshipped events, grouped by session in seq order. */
  unshipped(limit: number): TachoEvent[] {
    const out: TachoEvent[] = [];
    for (const session of this.sessions()) {
      const through = this.shippedThrough(session);
      for (const event of this.read(session)) {
        if (event.seq <= through) continue;
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
      const through = this.shippedThrough(session);
      for (const event of this.read(session)) {
        if (event.seq <= through) continue;
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
   * Why this exists. `compact` is the only other path that removes body
   * bytes, and it removes them one whole session at a time, once that session
   * is sealed, fully shipped, and older than the retention window. A session
   * that never seals is never compacted, so before this method a body queued
   * under `content_exact` stayed on disk for as long as the host ran, or for
   * ever on a host that never came back. The shipper stopped transmitting it
   * once the mandate narrowed, which protected the wire and left the bytes
   * where they were.
   *
   * How the write is safe against a concurrent append. `tacho-hook` appends
   * to a session's body file while the daemon is down, and the file is
   * append-only, so a line's offset never moves once it is written. This
   * method therefore overwrites each doomed line's bytes in place with
   * spaces, through one `r+` descriptor, and never truncates the file, moves
   * it, or changes its length. Every write lands inside `[0, length)` as it
   * stood at the read; an appender only ever writes past the end of the file.
   * The two cannot touch the same byte, so no append can be lost. A rewrite
   * through a temporary file and a rename would lose any line appended
   * between the read and the rename, which is why it is not used here.
   *
   * A blanked line reads as whitespace, and `bodiesFor` already skips a line
   * that trims to nothing, so the file stays valid for every reader. The
   * bytes are gone: the base64 text is replaced on the same blocks of the
   * same file, which is what `unlinkSync` in `compact` offers as well.
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
   * that withholds a body from a shipment. See
   * `purgeBodiesNarrowedOut` in the daemon.
   */
  purgeBodiesOutsideMandate(retention: RetentionMandate): number {
    let purged = 0;
    for (const session of this.sessions()) {
      const path = this.bodyFileFor(session);
      if (!existsSync(path)) continue;
      const kindOf = new Map(
        this.read(session).map(
          (event) => [event.event_id_idem, event.kind] as const,
        ),
      );
      const stored = readFileSync(path);
      const doomed: Array<{ start: number; length: number }> = [];
      let offset = 0;
      while (offset < stored.length) {
        const newline = stored.indexOf(0x0a, offset);
        const end = newline === -1 ? stored.length : newline;
        const length = end - offset;
        const line = stored.toString("utf8", offset, end);
        if (
          length > 0 &&
          line.trim().length > 0 &&
          !this.keeps(line, kindOf, retention)
        )
          doomed.push({ start: offset, length });
        offset = end + 1;
      }
      if (doomed.length === 0) continue;
      const fd = openSync(path, "r+");
      try {
        for (const span of doomed) {
          writeSync(
            fd,
            Buffer.alloc(span.length, 0x20),
            0,
            span.length,
            span.start,
          );
        }
        // The point of the call is that the bytes are gone from the disk, so
        // the erasure is flushed before the caller is told it happened.
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      purged += doomed.length;
    }
    return purged;
  }

  /**
   * Whether one line of a body file survives this mandate.
   *
   * Three answers, each for a reason:
   *
   * - A line that does not parse names no event, so nothing can ever ship it.
   *   A crash part way through an append leaves exactly this, with content in
   *   it, and keeping it would keep content under no mandate at all.
   * - A line whose event is not on the session's chain yet is kept. `append`
   *   writes bodies before events on purpose, so this is the microsecond
   *   between the two writes, not an orphan; the next pass sees the event and
   *   judges the body against its class.
   * - Otherwise the class comes from the event's kind and the one retention
   *   gate answers. A kind the table does not name has no class, so no
   *   mandate can cover it and the body is erased.
   */
  private keeps(
    line: string,
    kindOf: ReadonlyMap<string, string>,
    retention: RetentionMandate,
  ): boolean {
    let stored: StoredBody;
    try {
      stored = JSON.parse(line) as StoredBody;
    } catch {
      return false;
    }
    const kind = kindOf.get(stored.event_id_idem);
    if (kind === undefined) return true;
    const contentClass = contentClassOf(kind);
    if (contentClass === undefined) return false;
    return retentionAllows(retention, contentClass);
  }

  /**
   * Remove session files that are sealed, fully shipped, and older than
   * `retainMs`. The control plane holds the record; the host keeps a window
   * for `tacho export` and incident review.
   */
  compact(now: number, retainMs: number): string[] {
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
      if (existsSync(this.bodyFileFor(session)))
        unlinkSync(this.bodyFileFor(session));
      delete this.cursor.shipped[session];
      delete this.cursor.sealed[session];
      removed.push(session);
    }
    if (removed.length > 0) this.persistCursor();
    return removed;
  }
}
