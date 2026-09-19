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
 * NDJSON rather than SQLite keeps the package free of native modules and keeps
 * a read cheap enough to do on every tick.
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
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
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

  /** Every session with an event file, which is every session with a chain. */
  sessions(): string[] {
    return readdirSync(this.dir)
      .filter((name) => name.endsWith(".ndjson"))
      .map((name) => name.slice(0, -".ndjson".length))
      .sort();
  }

  /**
   * Every session with a body file, whether or not it has an event file.
   *
   * `sessions()` answers a different question and a retention sweep must not
   * ask it. It enumerates `.ndjson` files, so a session whose only file holds
   * bodies is invisible to it, and a crash between the two writes of the very
   * first `append` leaves exactly that: one `.bodies.jsonl` with a prompt in
   * it and no chain beside it. Sweeping the sessions with chains would walk
   * past that file for as long as the host ran, and `compact` would too,
   * because it also starts from `sessions()`.
   */
  private bodySessions(): string[] {
    return readdirSync(this.dir)
      .filter((name) => name.endsWith(".bodies.jsonl"))
      .map((name) => name.slice(0, -".bodies.jsonl".length))
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
   * Why this exists beside `dropBodies`. `dropBodies` reaches the bodies of
   * the events in a drain's batch, which is every body the shipper still has
   * an unshipped event for. Two kinds of body sit outside that reach: one
   * whose event already shipped, since `markShipped` advanced the cursor past
   * it, and one in a session the drain is not looking at. `compact` frees
   * those only once their session is sealed, fully shipped, and older than
   * the retention window, so a session that never seals kept them for as long
   * as the host ran, or for ever on a host that never came back. This sweep
   * walks every body file and every stored line, so a narrowing reaches all of
   * them. It starts from the body files rather than from the chains, because a
   * crash can leave a body file with no chain beside it and `sessions()` does
   * not see one. `bodySessions` says why.
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
    for (const session of this.bodySessions()) {
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
   * - A body whose event is not on the session's chain is an orphan and goes.
   *   `append` writes bodies before events, but it writes both in one
   *   synchronous run: four `appendFileSync` calls with no await between
   *   them, in a single-threaded process whose only writer is the daemon's
   *   recording path. A sweep therefore cannot observe the moment between the
   *   two writes of an append that is still in flight. An unmatched record is
   *   a record from an append that a crash cut short, and nothing will ever
   *   arrive to ship it: `bodiesFor` answers only the events it is handed, so
   *   the bytes would sit under no mandate for as long as the host kept the
   *   file. This branch used to keep them for the in-flight case that cannot
   *   happen.
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
   * A line that does not parse is handed to `keep` as `undefined`, rather than
   * throwing. A torn line is what a crash mid-append leaves, and a sweep that
   * threw on one would stop erasing the content around it.
   */
  private rewriteBodies(
    sessionUuid: string,
    keep: (stored: StoredBody | undefined) => boolean,
  ): number {
    const path = this.bodyFileFor(sessionUuid);
    if (!existsSync(path)) return 0;
    const kept: string[] = [];
    let cut = 0;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (line.trim().length === 0) continue;
      let stored: StoredBody | undefined;
      try {
        stored = JSON.parse(line) as StoredBody;
      } catch {
        stored = undefined;
      }
      if (keep(stored)) kept.push(line);
      else cut += 1;
    }
    if (cut === 0) return 0;
    if (kept.length === 0) unlinkSync(path);
    else writeSensitiveFileAtomic(path, `${kept.join("\n")}\n`);
    return cut;
  }

  /**
   * Remove session files that are sealed, fully shipped, and older than
   * `retainMs`, and body files that have no chain beside them and are that
   * old. The control plane holds the record; the host keeps a window for
   * `tacho export` and incident review.
   *
   * The second case is the crash-created orphan. A crash between the body
   * write and the event write of a session's first `append` leaves a
   * `.bodies.jsonl` alone, and nothing can ever ship what is in it, because
   * `unshipped` reads the chain and there is no chain. Left alone it would
   * outlive every window the operator set. `retainMs` still applies, measured
   * from the file's mtime, so this never races a session the daemon is
   * recording right now.
   */
  compact(now: number, retainMs: number): string[] {
    const removed: string[] = [];
    for (const session of this.bodySessions()) {
      if (existsSync(this.fileFor(session))) continue;
      const path = this.bodyFileFor(session);
      if (now - statSync(path).mtimeMs < retainMs) continue;
      unlinkSync(path);
      removed.push(session);
    }
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
