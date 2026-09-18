import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FrameBody } from "../evidence/frame-body";
import { minimalSession } from "../test-helpers";
import { scratchPaths } from "./test-support";
import { Wal } from "./wal";

describe("Wal", () => {
  it("appends per session, reads in order, and tracks the shipped cursor", () => {
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    const session = minimalSession();
    wal.append(session.slice(0, 2));
    wal.append(session.slice(2));
    const uuid = session[0]?.session_uuid as string;
    expect(wal.sessions()).toEqual([uuid]);
    expect(wal.read(uuid).map((e) => e.seq)).toEqual(session.map((e) => e.seq));
    expect(wal.head(uuid)?.kind).toBe("agent_stop");
    expect(wal.unshipped(2)).toHaveLength(2);
    expect(wal.stats()).toMatchObject({
      sessions: 1,
      unshipped: session.length,
      oldestUnshippedAt: session[0]?.ts,
    });
    wal.markShipped(uuid, 1);
    expect(wal.unshipped(100).map((e) => e.seq)).toEqual(
      session.slice(2).map((e) => e.seq),
    );
    wal.markShipped(uuid, 0);
    expect(wal.shippedThrough(uuid)).toBe(1);
    // A second instance sees the persisted cursor.
    const again = new Wal(paths.wal);
    expect(again.shippedThrough(uuid)).toBe(1);
    expect(again.read("00000000-0000-4000-8000-000000000000")).toEqual([]);
    expect(again.head("00000000-0000-4000-8000-000000000000")).toBeUndefined();
    const cursor = JSON.parse(
      readFileSync(join(paths.wal, "cursor.json"), "utf8"),
    ) as { sealed: Record<string, string> };
    expect(cursor.sealed[uuid]).toBe(session[session.length - 1]?.ts);
  });

  it("compacts only sealed, fully shipped, old sessions", () => {
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    const session = minimalSession();
    const uuid = session[0]?.session_uuid as string;
    wal.append(session);
    const later =
      Date.parse(session[session.length - 1]?.ts as string) +
      10 * 24 * 60 * 60_000;
    expect(wal.compact(later, 7 * 24 * 60 * 60_000)).toEqual([]);
    wal.markShipped(uuid, session.length - 1);
    expect(wal.compact(Date.now(), 7 * 24 * 60 * 60_000)).toEqual([]);
    expect(
      wal.compact(Date.now() + 10 * 24 * 60 * 60_000, 7 * 24 * 60 * 60_000),
    ).toEqual([uuid]);
    expect(existsSync(join(paths.wal, `${uuid}.ndjson`))).toBe(false);
    expect(wal.stats().sessions).toBe(0);
  });

  it("files bodies beside their events and answers them per batch", () => {
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    const session = minimalSession();
    const uuid = session[0]?.session_uuid as string;
    const bodyOf = (index: number, text: string): FrameBody => ({
      event_id_idem: session[index]?.event_id_idem as string,
      session_uuid: uuid,
      seq: session[index]?.seq as number,
      content_type: "text/plain; charset=utf-8",
      bytes: new TextEncoder().encode(text),
      content_class: "model_call",
    });
    wal.append(session.slice(0, 2), [bodyOf(1, "first prompt")]);
    wal.append(session.slice(2), [bodyOf(2, "second prompt")]);
    // The body file is not a session: the listing is unchanged.
    expect(wal.sessions()).toEqual([uuid]);
    expect(existsSync(join(paths.wal, `${uuid}.bodies.jsonl`))).toBe(true);

    // Bodies come back in event order, one per event, base64 on the wire.
    const bodies = wal.bodiesFor(session);
    expect(bodies.map((b) => b.event_id_idem)).toEqual([
      session[1]?.event_id_idem,
      session[2]?.event_id_idem,
    ]);
    expect(
      Buffer.from(bodies[0]?.bytes_base64 as string, "base64").toString(),
    ).toBe("first prompt");
    expect(bodies[0]?.content_type).toBe("text/plain; charset=utf-8");
    // A batch that holds only the tail gets only the tail's body.
    expect(wal.bodiesFor(session.slice(2)).map((b) => b.event_id_idem)).toEqual(
      [session[2]?.event_id_idem],
    );
    expect(wal.bodiesFor([])).toEqual([]);
    // A session that never had a body file answers nothing.
    expect(
      wal.bodiesFor([
        {
          ...(session[0] as (typeof session)[number]),
          session_uuid: "00000000-0000-4000-8000-000000000000",
        },
      ]),
    ).toEqual([]);

    // Compaction takes the body file with the session.
    wal.markShipped(uuid, session.length - 1);
    expect(
      wal.compact(Date.now() + 10 * 24 * 60 * 60_000, 7 * 24 * 60 * 60_000),
    ).toEqual([uuid]);
    expect(existsSync(join(paths.wal, `${uuid}.bodies.jsonl`))).toBe(false);
  });
});
