/**
 * The write-ahead log (spec section 3 "WAL"): one append-only NDJSON file
 * per session under `wal/`, plus a cursor of what the control plane has
 * acknowledged. Events are sealed before they land here, so the file is the
 * chain; a batch is "shipped" only when ingest accepted it, and ingest is
 * idempotent on `event_id_idem`, which makes delivery at-least-once safe.
 *
 * NDJSON rather than SQLite keeps the package free of native modules and lets
 * `tacho-hook` append with one syscall while the daemon is down.
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
  ensureDir,
  readJsonFileIfExists,
  writeSensitiveFileAtomic,
} from "./fs";

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

  private persistCursor(): void {
    writeSensitiveFileAtomic(this.cursorPath, JSON.stringify(this.cursor));
  }

  /** Append sealed events; each goes to its own session's file. */
  append(events: readonly TachoEvent[]): void {
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
      delete this.cursor.shipped[session];
      delete this.cursor.sealed[session];
      removed.push(session);
    }
    if (removed.length > 0) this.persistCursor();
    return removed;
  }
}
