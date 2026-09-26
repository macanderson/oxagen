/**
 * What a restarted daemon reads from its event files before it can ship, and
 * what the hourly compaction reads (audit finding C-05, #3944).
 *
 * The WAL keeps each session's last seq and the byte its shipped cursor sits
 * at in memory. After a restart, the first `stats()` read every event file
 * end to end to find each last seq, the first drain walked each shipped
 * prefix from byte 0, a journaled terminal's flush read the whole file to
 * check for seqs it already held, and compaction parsed every sealed
 * session's file before it looked at the session's age.
 *
 * The tests count the bytes read from event files on the synchronous path,
 * the way `wal-index.test.ts` counts body reads.
 */
import { join } from "node:path";
import { readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { TachoEvent } from "../envelope";
import { minimalSession } from "../test-helpers";
import { scratchPaths } from "./test-support";
import { Wal } from "./wal";

/** Bytes read from any session's event file. */
const eventReads = vi.hoisted(() => ({ fds: new Set<number>(), bytes: 0 }));

function isEventFile(path: unknown): boolean {
  return String(path).endsWith(".ndjson");
}

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    openSync: ((path, ...rest) => {
      const fd = fs.openSync(path, ...rest);
      if (isEventFile(path)) eventReads.fds.add(fd);
      return fd;
    }) as typeof fs.openSync,
    closeSync: ((fd) => {
      eventReads.fds.delete(fd);
      fs.closeSync(fd);
    }) as typeof fs.closeSync,
    readSync: ((fd, ...rest) => {
      const size = (fs.readSync as (...args: unknown[]) => number)(fd, ...rest);
      if (eventReads.fds.has(fd)) eventReads.bytes += size;
      return size;
    }) as typeof fs.readSync,
    readFileSync: ((path, ...rest) => {
      const out = (fs.readFileSync as (...args: unknown[]) => Buffer | string)(
        path,
        ...rest,
      );
      if (isEventFile(path)) eventReads.bytes += Buffer.byteLength(out);
      return out;
    }) as typeof fs.readFileSync,
  };
});

const EVENTS = 5_000;
const OLD_SESSION = "5c1f0a2e-0000-4000-8000-0000000000a1";
const YOUNG_SESSION = "5c1f0a2e-0000-4000-8000-0000000000a2";

/** One long session: `count` events in seq order, the last an `agent_stop`. */
function longSession(session: string, count = EVENTS): TachoEvent[] {
  const template = minimalSession();
  const call = template.find((event) => event.kind === "llm_call")!;
  // Sealed long ago, so a session's age for compaction is its file's.
  const stop = { ...template.at(-1)!, ts: "2026-01-01T00:00:00.000Z" };
  const events: TachoEvent[] = [];
  for (let seq = 0; seq < count; seq += 1)
    events.push({
      ...(seq === count - 1 ? stop : call),
      session_uuid: session,
      root_session_uuid: session,
      seq,
      event_id_idem: `evt_${seq.toString(16).padStart(60, "0")}${session.slice(-4)}`,
    });
  return events;
}

/** Ship one session through `last`, the way the shipper does, in batches. */
function shipThrough(wal: Wal, last: number): void {
  for (;;) {
    const batch = wal.unshipped(200).filter((event) => event.seq <= last);
    if (batch.length === 0) return;
    wal.markShipped(OLD_SESSION, batch.at(-1)!.seq);
  }
}

function eventBytesDuring(run: () => void): number {
  const before = eventReads.bytes;
  run();
  return eventReads.bytes - before;
}

describe("the WAL after a restart", () => {
  it("reads the tail of each file, not the file, for the first stats()", () => {
    const paths = scratchPaths();
    const events = longSession(OLD_SESSION);
    const wal = new Wal(paths.wal);
    wal.append(events);
    shipThrough(wal, EVENTS - 11);
    const size = statSync(join(paths.wal, `${OLD_SESSION}.ndjson`)).size;

    const restarted = new Wal(paths.wal);
    let stats: ReturnType<Wal["stats"]> | undefined;
    const read = eventBytesDuring(() => {
      stats = restarted.stats();
    });
    expect(stats).toEqual({
      sessions: 1,
      unshipped: 10,
      oldestUnshippedAt: events[EVENTS - 10]!.ts,
    });
    expect(read).toBeLessThan(size / 10);
  });

  it("starts the first drain where the shipped cursor sits", () => {
    const paths = scratchPaths();
    const events = longSession(OLD_SESSION);
    const wal = new Wal(paths.wal);
    wal.append(events);
    // Ship all but the last 100.
    shipThrough(wal, EVENTS - 101);
    const size = statSync(join(paths.wal, `${OLD_SESSION}.ndjson`)).size;

    const restarted = new Wal(paths.wal);
    let batch: TachoEvent[] = [];
    const read = eventBytesDuring(() => {
      batch = restarted.unshipped(200);
    });
    expect(batch.map((event) => event.seq)).toEqual(
      events.slice(EVENTS - 100).map((event) => event.seq),
    );
    expect(read).toBeLessThan(size / 10);
  });

  it("ignores a saved resume mark that does not sit where it claims", () => {
    const paths = scratchPaths();
    const events = longSession(OLD_SESSION, 300);
    const wal = new Wal(paths.wal);
    wal.append(events);
    wal.markShipped(OLD_SESSION, wal.unshipped(200).at(-1)!.seq);
    wal.unshipped(200);
    wal.markShipped(OLD_SESSION, 249);
    const cursorPath = join(paths.wal, "cursor.json");
    const saved = JSON.parse(readFileSync(cursorPath, "utf8")) as {
      resume?: Record<string, [number, number]>;
    };
    expect(saved.resume?.[OLD_SESSION]).toBeDefined();
    const [afterSeq, offset] = saved.resume![OLD_SESSION]!;
    // One byte off: the mark no longer ends a line.
    saved.resume![OLD_SESSION] = [afterSeq, offset - 1];
    writeFileSync(cursorPath, JSON.stringify(saved));
    expect(new Wal(paths.wal).unshipped(200).map((event) => event.seq)).toEqual(
      events.slice(250).map((event) => event.seq),
    );
  });

  it("checks a journaled terminal against the file's tail, not the whole file", () => {
    const paths = scratchPaths();
    const events = longSession(OLD_SESSION);
    const wal = new Wal(paths.wal);
    wal.append(events.slice(0, -1));
    const size = statSync(join(paths.wal, `${OLD_SESSION}.ndjson`)).size;

    const restarted = new Wal(paths.wal);
    const read = eventBytesDuring(() => {
      restarted.appendRecovered(events.slice(-2));
      // A retry of the same batch finds both events durable.
      restarted.appendRecovered(events.slice(-2));
    });
    expect(restarted.lastEvent(OLD_SESSION)).toEqual(events.at(-1));
    expect(read).toBeLessThan(size / 10);
  });
});

describe("compaction", () => {
  it("reads nothing of a session too young to remove, and the tail of one old enough", () => {
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    wal.append(longSession(OLD_SESSION));
    wal.append(longSession(YOUNG_SESSION));
    wal.markShipped(OLD_SESSION, EVENTS - 1);
    wal.markShipped(YOUNG_SESSION, EVENTS - 1);
    const now = Date.now();
    const oldPath = join(paths.wal, `${OLD_SESSION}.ndjson`);
    const threeDaysAgo = (now - 3 * 86_400_000) / 1000;
    utimesSync(oldPath, threeDaysAgo, threeDaysAgo);
    const size = statSync(oldPath).size;

    const restarted = new Wal(paths.wal);
    let removed: string[] = [];
    const read = eventBytesDuring(() => {
      removed = restarted.compact(now, 86_400_000);
    });
    expect(removed).toEqual([OLD_SESSION]);
    expect(restarted.sessions()).toEqual([YOUNG_SESSION]);
    expect(read).toBeLessThan(size / 10);
  });
});
