/**
 * The witness for issue #3694: shipping a long session costs the batch, not
 * the session.
 *
 * A session is grown to 20,000 events, each carrying a model body, and shipped
 * in waves of 1,000. Every wave moves the same number of events, so the cost
 * of a wave is what says whether shipping is linear in the batch or in the
 * session. Against the read that scanned the body file from the top, the last
 * five waves cost 5.7 times the first five, because each of a wave's five
 * batches re-read every byte written so far. Against the index they cost 1.0
 * times, measured on 2026-09-22.
 *
 * The test counts the bytes each wave reads from the body file rather than
 * timing it. Wall time under a coverage run on a shared CI runner put the last
 * waves at 4.5 times the first with the index in place, which failed main's
 * test job on 2026-09-24. A byte count is the same on every machine.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Shipper } from "../collector/spool";
import type { TachoEvent } from "../envelope";
import type { FrameBody } from "../evidence/frame-body";
import type { ControlClient } from "./control-client";
import { minimalSession } from "../test-helpers";
import { scratchPaths } from "./test-support";
import { TACHO_MAX_BATCH } from "../wire";
import { Wal } from "./wal";

/** Bytes read from any session's body file, by the sync and async paths. */
const bodyReads = vi.hoisted(() => ({ fds: new Set<number>(), bytes: 0 }));

function isBodyFile(path: unknown): boolean {
  return String(path).endsWith(".bodies.jsonl");
}

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    openSync: ((path, ...rest) => {
      const fd = fs.openSync(path, ...rest);
      if (isBodyFile(path)) bodyReads.fds.add(fd);
      return fd;
    }) as typeof fs.openSync,
    closeSync: ((fd) => {
      bodyReads.fds.delete(fd);
      fs.closeSync(fd);
    }) as typeof fs.closeSync,
    readSync: ((fd, ...rest) => {
      const size = (fs.readSync as (...args: unknown[]) => number)(
        fd,
        ...rest,
      );
      if (bodyReads.fds.has(fd)) bodyReads.bytes += size;
      return size;
    }) as typeof fs.readSync,
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const fsp = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fsp,
    open: (async (path, ...rest) => {
      const handle = await fsp.open(path, ...rest);
      if (!isBodyFile(path)) return handle;
      const read = handle.read.bind(handle) as (
        ...args: unknown[]
      ) => Promise<{ bytesRead: number }>;
      (handle as { read: unknown }).read = async (...args: unknown[]) => {
        const result = await read(...args);
        bodyReads.bytes += result.bytesRead;
        return result;
      };
      return handle;
    }) as typeof fsp.open,
  };
});

const SESSION = "5c1f0a2e-0000-4000-8000-00000000f00d";
const TOTAL_EVENTS = 20_000;
const WAVE = 1_000;
const BODY_BYTES = 2_048;

/** A hex event id of the shape the envelope requires, one per seq. */
function idemFor(seq: number): string {
  return `evt_${seq.toString(16).padStart(64, "0")}`;
}

/** One session's worth of `llm_call` events, each with a body to ship. */
function wave(from: number): { events: TachoEvent[]; bodies: FrameBody[] } {
  const template = minimalSession().find(
    (event) => event.kind === "llm_call",
  ) as TachoEvent;
  const events: TachoEvent[] = [];
  const bodies: FrameBody[] = [];
  for (let seq = from; seq < from + WAVE; seq += 1) {
    const event_id_idem = idemFor(seq);
    events.push({
      ...template,
      session_uuid: SESSION,
      root_session_uuid: SESSION,
      seq,
      event_id_idem,
    });
    bodies.push({
      event_id_idem,
      session_uuid: SESSION,
      seq,
      content_type: "application/json",
      bytes: new TextEncoder().encode("c".repeat(BODY_BYTES)),
      content_class: "model_call",
    });
  }
  return { events, bodies };
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

describe("shipping a long session", () => {
  it("costs the batch and not the session as the body file grows", async () => {
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    let batches = 0;
    let shippedEvents = 0;
    let shippedBodies = 0;
    const ingest = async (
      events: readonly TachoEvent[],
      _health: unknown,
      bodies: readonly unknown[] = [],
    ) => {
      batches += 1;
      shippedEvents += events.length;
      shippedBodies += bodies.length;
      return {
        accepted: events.length,
        event_ids: [],
        chain_breaks: [],
        body_rejections: [],
        control: {
          host_status: "active",
          deny_generation: { org: 1, workspace: 1 },
          bundle_etag: "e",
          commands: [],
        },
      };
    };
    const shipper = new Shipper({
      wal,
      client: { ingest } as unknown as ControlClient,
      quarantineDir: join(paths.wal, "quarantine"),
      // The daemon builds its health from `Wal.stats`, so the health call is
      // on the shipping path and belongs in the measurement.
      health: () => ({ version: "1", spool_depth: wal.stats().unshipped }),
      onControl: () => {},
      retentionInForce: () => ({
        mandate: { mode: "content_exact", classes: ["model_call"] },
        proven: true,
      }),
      log: () => {},
      now: () => Date.now(),
    });

    const waveBytes: number[] = [];
    for (let from = 0; from < TOTAL_EVENTS; from += WAVE) {
      const { events, bodies } = wave(from);
      wal.append(events, bodies);
      const readBefore = bodyReads.bytes;
      await shipper.drain();
      waveBytes.push(bodyReads.bytes - readBefore);
    }

    // Every event and every body left, in full batches and no more.
    expect(shippedEvents).toBe(TOTAL_EVENTS);
    expect(shippedBodies).toBe(TOTAL_EVENTS);
    expect(batches).toBe(TOTAL_EVENTS / TACHO_MAX_BATCH);
    expect(wal.unshipped(1)).toEqual([]);
    expect(wal.stats().unshipped).toBe(0);

    // The last five waves ship a file about six times the size the first five
    // did. A scan-per-batch read re-reads the whole file for each batch, so
    // its later waves read several times the bytes. An offset read takes each
    // wave's bodies and nothing else, so every wave reads about the same.
    const quarter = waveBytes.length / 4;
    const first = mean(waveBytes.slice(0, quarter));
    const last = mean(waveBytes.slice(-quarter));
    expect(first).toBeGreaterThan(0);
    expect(last).toBeLessThan(first * 1.5);

    // The index is beside the bodies, holds no content, and is a fraction of
    // the file it describes.
    const bodyBytes = statSync(join(paths.wal, `${SESSION}.bodies.jsonl`)).size;
    const indexBytes = statSync(
      join(paths.wal, `${SESSION}.bodies.index`),
    ).size;
    expect(indexBytes).toBeLessThan(bodyBytes / 4);
  }, 120_000);

  it("ships a body file that was already on disk with no index beside it", async () => {
    const paths = scratchPaths();
    const first = new Wal(paths.wal);
    const { events, bodies } = wave(0);
    first.append(events.slice(0, 50), bodies.slice(0, 50));
    // What an enrolled host holds today: bodies written before the index
    // existed. The next read builds it rather than failing or re-reading.
    for (const name of readdirSync(paths.wal))
      expect(name.endsWith(".bodies.index")).toBe(false);

    const wal = new Wal(paths.wal);
    const read = await wal.bodiesForAsync(events.slice(0, 50));
    expect(read).toHaveLength(50);
    expect(
      Buffer.from(read[0]?.bytes_base64 as string, "base64").toString("utf8"),
    ).toBe("c".repeat(BODY_BYTES));
    expect(
      readdirSync(paths.wal).filter((name) => name.endsWith(".bodies.index")),
    ).toEqual([`${SESSION}.bodies.index`]);

    // A second read answers from the index and agrees with the first.
    expect(await wal.bodiesForAsync(events.slice(0, 50))).toEqual(read);
    // So does a fresh process, which loads the index rather than scanning.
    expect(new Wal(paths.wal).bodiesFor(events.slice(0, 50))).toEqual(read);
  });

  it("rebuilds the index when the body file no longer matches it", async () => {
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    const { events, bodies } = wave(0);
    wal.append(events.slice(0, 20), bodies.slice(0, 20));
    expect(await wal.bodiesForAsync(events.slice(0, 20))).toHaveLength(20);

    // A mandate that narrows rewrites the file, which moves every offset.
    expect(wal.dropBodies(events.slice(0, 5))).toBe(5);
    const after = wal.bodiesFor(events.slice(0, 20));
    expect(after.map((body) => body.event_id_idem)).toEqual(
      events.slice(5, 20).map((event) => event.event_id_idem),
    );

    // Appending after the rewrite extends the rebuilt index.
    wal.append(events.slice(20, 25), bodies.slice(20, 25));
    expect(wal.bodiesFor(events.slice(0, 25))).toHaveLength(20);
  });
});

/** A WAL holding one session of `count` events and bodies, already indexed. */
async function indexed(count: number): Promise<{
  paths: ReturnType<typeof scratchPaths>;
  wal: Wal;
  events: TachoEvent[];
  report: ReturnType<typeof vi.fn>;
  sidecar: string;
  bodyPath: string;
}> {
  const paths = scratchPaths();
  const report = vi.fn();
  const wal = new Wal(paths.wal, report);
  const { events, bodies } = wave(0);
  wal.append(events.slice(0, count), bodies.slice(0, count));
  await wal.bodiesForAsync(events.slice(0, count));
  return {
    paths,
    wal,
    events: events.slice(0, count),
    report,
    sidecar: join(paths.wal, `${SESSION}.bodies.index`),
    bodyPath: join(paths.wal, `${SESSION}.bodies.jsonl`),
  };
}

describe("the body index sidecar", () => {
  it("is rebuilt when its header is not one this version wrote", async () => {
    const { paths, events, sidecar } = await indexed(10);
    writeFileSync(sidecar, '["tacho/bodies-index",99]\n["through",0]\n');
    const wal = new Wal(paths.wal);
    expect(wal.bodiesFor(events)).toHaveLength(10);
    expect(readFileSync(sidecar, "utf8")).toContain('["tacho/bodies-index",1]');
  });

  it("rescans the region a torn final line covered", async () => {
    const { paths, events, sidecar } = await indexed(10);
    const text = readFileSync(sidecar, "utf8");
    truncateSync(sidecar, text.length - 12);
    const wal = new Wal(paths.wal);
    expect(wal.bodiesFor(events)).toHaveLength(10);
  });

  it("is discarded when it points at the wrong bytes", async () => {
    const { paths, events, sidecar, bodyPath } = await indexed(10);
    const size = statSync(bodyPath).size;
    writeFileSync(
      sidecar,
      [
        '["tacho/bodies-index",1]',
        JSON.stringify([events[0]?.event_id_idem, 3, 40]),
        JSON.stringify(["through", size]),
        "",
      ].join("\n"),
    );
    const wal = new Wal(paths.wal);
    expect(wal.bodiesFor(events)).toHaveLength(10);
  });

  it("ships the events of a body file that holds no records at all", async () => {
    const { paths, events, report, bodyPath } = await indexed(4);
    const wal = new Wal(paths.wal, report);
    // Nothing in the file is a record any more. The events still ship, and
    // the control plane records their frames with a `body_missing` gap.
    writeFileSync(bodyPath, "x".repeat(statSync(bodyPath).size));
    expect(wal.bodiesFor(events)).toEqual([]);
    expect(report).toHaveBeenCalledWith({
      session_uuid: SESSION,
      operation: "read",
      code: "invalid_body_record",
    });
  });

  it("reads a body file whose last append was cut short", async () => {
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    const { events, bodies } = wave(0);
    wal.append(events.slice(0, 3), bodies.slice(0, 3));
    const bodyPath = join(paths.wal, `${SESSION}.bodies.jsonl`);
    truncateSync(bodyPath, statSync(bodyPath).size - 1);
    expect(await wal.bodiesForAsync(events.slice(0, 3))).toHaveLength(3);
  });

  it("goes when its session is compacted and when its body file goes", async () => {
    const { paths, wal, events, sidecar } = await indexed(3);
    const orphan = join(paths.wal, "orphan-session.bodies.index");
    appendFileSync(orphan, '["tacho/bodies-index",1]\n["through",0]\n');
    wal.markShipped(SESSION, events[events.length - 1]?.seq as number);
    // Nothing sealed this session, so compaction leaves it and takes the
    // sidecar whose body file is already gone.
    wal.compact(Date.now(), 0);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(sidecar)).toBe(true);
  });

  it("answers a session it has evicted from memory", async () => {
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    const { events, bodies } = wave(0);
    const sessions: TachoEvent[][] = [];
    // One more session than the store keeps, so the first is evicted.
    for (let index = 0; index < 10; index += 1) {
      const uuid = `5c1f0a2e-0000-4000-8000-0000000000${index.toString().padStart(2, "0")}`;
      const own = events.slice(0, 2).map((event, offset) => ({
        ...event,
        session_uuid: uuid,
        event_id_idem: `${event.event_id_idem.slice(0, -2)}${index}${offset}`,
      }));
      wal.append(
        own,
        own.map((event, offset) => ({
          ...(bodies[offset] as FrameBody),
          session_uuid: uuid,
          event_id_idem: event.event_id_idem,
        })),
      );
      sessions.push(own);
      expect(wal.bodiesFor(own)).toHaveLength(2);
    }
    expect(wal.bodiesFor(sessions[0] as TachoEvent[])).toHaveLength(2);
  });

  it("fails the read when the body file cannot be opened", async () => {
    const paths = scratchPaths();
    const report = vi.fn();
    const wal = new Wal(paths.wal, report);
    const { events } = wave(0);
    wal.append(events.slice(0, 1));
    mkdirSync(join(paths.wal, `${SESSION}.bodies.jsonl`));
    await expect(wal.bodiesForAsync(events.slice(0, 1))).rejects.toThrow();
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ session_uuid: SESSION, operation: "read" }),
    );
  });
});
