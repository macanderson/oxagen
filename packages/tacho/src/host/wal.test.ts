import { appendFileSync, existsSync, readFileSync } from "node:fs";
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

  it("drops the bytes of named bodies and keeps the events and the rest", () => {
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
    wal.append(session, [bodyOf(1, "first prompt"), bodyOf(2, "second")]);

    expect(wal.dropBodies([session[1] as (typeof session)[number]])).toBe(1);
    // The event survives: the chain is the record, only the content went.
    expect(wal.read(uuid)).toHaveLength(session.length);
    expect(wal.bodiesFor(session).map((b) => b.event_id_idem)).toEqual([
      session[2]?.event_id_idem,
    ]);
    // The bytes are off the disk, not merely unreferenced.
    expect(
      readFileSync(join(paths.wal, `${uuid}.bodies.jsonl`), "utf8"),
    ).not.toContain(Buffer.from("first prompt").toString("base64"));

    // Dropping what is already gone changes nothing (negative).
    expect(wal.dropBodies([session[1] as (typeof session)[number]])).toBe(0);
    // A session with no body file answers zero (negative).
    expect(
      wal.dropBodies([
        {
          ...(session[0] as (typeof session)[number]),
          session_uuid: "00000000-0000-4000-8000-000000000000",
        },
      ]),
    ).toBe(0);

    // The last body going takes the file with it.
    expect(wal.dropBodies([session[2] as (typeof session)[number]])).toBe(1);
    expect(existsSync(join(paths.wal, `${uuid}.bodies.jsonl`))).toBe(false);
    expect(wal.bodiesFor(session)).toEqual([]);
  });

  it("sweeps bodies a narrowed mandate no longer covers, in a session that never seals", () => {
    // `dropBodies` reaches the bodies of one batch, which is every body the
    // drain still has an unshipped event for. It cannot reach a body whose
    // event already shipped, and `compact` frees a body file only once its
    // session is sealed, fully shipped, and past the retention window. A
    // session that never seals satisfies neither, so before this sweep its
    // bodies stayed on disk with no bound at all.
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    const session = minimalSession();
    const uuid = session[0]?.session_uuid as string;
    // Every event but the closing `agent_stop`: nothing seals this session, so
    // `compact` will never touch it.
    const live = session.slice(0, -1);
    const bodyAt = (index: number, text: string): FrameBody => ({
      event_id_idem: live[index]?.event_id_idem as string,
      session_uuid: uuid,
      seq: live[index]?.seq as number,
      content_type: "text/plain; charset=utf-8",
      bytes: new TextEncoder().encode(text),
      content_class: "model_call",
    });
    const promptIndex = live.findIndex((event) => event.kind === "turn_start");
    const toolIndex = live.findIndex(
      (event) => event.kind === "tool_requested",
    );
    wal.append(live, [
      bodyAt(promptIndex, "the raw prompt"),
      bodyAt(toolIndex, "the tool arguments"),
    ]);
    const bodyPath = join(paths.wal, `${uuid}.bodies.jsonl`);
    expect(readFileSync(bodyPath, "utf8")).toContain(
      Buffer.from("the raw prompt").toString("base64"),
    );
    // Every event shipped, so no batch names these bodies again.
    wal.markShipped(uuid, live.length - 1);
    expect(wal.unshipped(100)).toEqual([]);
    // Unsealed, so compaction refuses it whatever the age.
    expect(
      wal.compact(Date.now() + 365 * 24 * 60 * 60_000, 7 * 24 * 60 * 60_000),
    ).toEqual([]);

    // The mandate narrows to tool content. The prompt body goes, the tool body
    // stays, and the chain is untouched.
    expect(
      wal.purgeBodiesOutsideMandate({
        mode: "content_exact",
        classes: ["tool_call"],
      }),
    ).toBe(1);
    const after = readFileSync(bodyPath, "utf8");
    expect(after).not.toContain(
      Buffer.from("the raw prompt").toString("base64"),
    );
    expect(after).toContain(
      Buffer.from("the tool arguments").toString("base64"),
    );
    expect(wal.read(uuid).length).toBe(live.length);
    expect(wal.bodiesFor(live).map((b) => b.event_id_idem)).toEqual([
      live[toolIndex]?.event_id_idem,
    ]);

    // Nothing is covered now, so the last body goes and takes the file.
    expect(
      wal.purgeBodiesOutsideMandate({ mode: "digest_only", classes: [] }),
    ).toBe(1);
    expect(existsSync(bodyPath)).toBe(false);
    // Erasing does not reverse: widening again brings nothing back.
    expect(
      wal.purgeBodiesOutsideMandate({
        mode: "content_exact",
        classes: ["model_call", "tool_call"],
      }),
    ).toBe(0);
    expect(wal.bodiesFor(live)).toEqual([]);
  });

  it("sweeps a torn line and keeps a body whose event is not on the chain yet", () => {
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    const session = minimalSession();
    const uuid = session[0]?.session_uuid as string;
    const promptIndex = session.findIndex(
      (event) => event.kind === "turn_start",
    );
    const bodyPath = join(paths.wal, `${uuid}.bodies.jsonl`);
    wal.append(session, [
      {
        event_id_idem: session[promptIndex]?.event_id_idem as string,
        session_uuid: uuid,
        seq: session[promptIndex]?.seq as number,
        content_type: "text/plain; charset=utf-8",
        bytes: new TextEncoder().encode("covered prompt"),
        content_class: "model_call",
      },
    ]);
    // `append` writes bodies before events, so a crash between the two leaves
    // a body whose event is not on the chain. That is a microsecond, not an
    // orphan, and the next sweep judges it once the event lands.
    appendFileSync(
      bodyPath,
      `${JSON.stringify({
        event_id_idem: "evt_not_on_this_chain",
        seq: 99,
        content_type: "text/plain; charset=utf-8",
        bytes_base64: Buffer.from("body ahead of its event").toString("base64"),
      })}\n`,
    );
    // A line cut short by a crash names no event, so nothing can ever ship it.
    appendFileSync(bodyPath, '{"event_id_idem":"evt_torn","bytes_base6\n');

    expect(
      wal.purgeBodiesOutsideMandate({ mode: "digest_only", classes: [] }),
    ).toBe(2);
    const after = readFileSync(bodyPath, "utf8");
    expect(after).not.toContain(
      Buffer.from("covered prompt").toString("base64"),
    );
    expect(after).not.toContain("evt_torn");
    expect(after).toContain(
      Buffer.from("body ahead of its event").toString("base64"),
    );
  });
});
