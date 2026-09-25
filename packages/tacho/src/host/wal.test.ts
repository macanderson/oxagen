import {
  appendFileSync,
  existsSync,
  fdatasyncSync,
  fsyncSync,
  renameSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  truncateSync,
  writeFileSync,
  writeSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { FrameBody } from "../evidence/frame-body";
import { minimalSession } from "../test-helpers";
import { scratchPaths } from "./test-support";
import { Wal } from "./wal";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    appendFileSync: vi.fn(actual.appendFileSync),
    readFileSync: vi.fn(actual.readFileSync),
    readSync: vi.fn(actual.readSync),
    writeSync: vi.fn(actual.writeSync),
    fsyncSync: vi.fn(actual.fsyncSync),
    fdatasyncSync: vi.fn(actual.fdatasyncSync),
    renameSync: vi.fn(actual.renameSync),
    unlinkSync: vi.fn(actual.unlinkSync),
  };
});

describe("Wal", () => {
  it("recovers an exact journaled terminal after an event write left a torn tail", () => {
    const paths = scratchPaths();
    const events = minimalSession();
    const terminal = events[events.length - 1]!;
    const wal = new Wal(paths.wal);
    wal.append(events.slice(0, -1));
    appendFileSync(
      join(paths.wal, `${terminal.session_uuid}.ndjson`),
      JSON.stringify(terminal).slice(0, 80),
    );
    const restarted = new Wal(paths.wal);
    restarted.appendRecovered([terminal]);
    expect(restarted.read(terminal.session_uuid)).toEqual(events);
    restarted.appendRecovered([terminal]);
    expect(restarted.read(terminal.session_uuid)).toEqual(events);
  });

  it("refuses conflicting recovery evidence at an already durable sequence", () => {
    const paths = scratchPaths();
    const events = minimalSession();
    const terminal = events[events.length - 1]!;
    const wal = new Wal(paths.wal);
    wal.append(events);
    expect(() =>
      wal.appendRecovered([{ ...terminal, hash: `sha256:${"f".repeat(64)}` }]),
    ).toThrow(/WAL recovery conflict/);
    expect(wal.read(terminal.session_uuid)).toEqual(events);
  });
  it("retries a journaled terminal batch without storing its bodies twice", () => {
    const paths = scratchPaths();
    const session = minimalSession();
    const uuid = session[0]?.session_uuid as string;
    const terminal = session[session.length - 1] as (typeof session)[number];
    const body: FrameBody = {
      event_id_idem: terminal.event_id_idem,
      session_uuid: uuid,
      seq: terminal.seq,
      content_type: "text/plain; charset=utf-8",
      bytes: new TextEncoder().encode("the sealed turn"),
      content_class: "model_call",
    };
    const wal = new Wal(paths.wal);
    wal.append(session.slice(0, -1));
    // The daemon journals the terminal batch and is asked to land it three
    // times: the first flush, a second SessionEnd on the same chain, and a
    // restart that read the journal entry before anything cleared it.
    wal.appendRecovered([terminal], [body]);
    wal.appendRecovered([terminal], [body]);
    const restarted = new Wal(paths.wal);
    restarted.appendRecovered([terminal], [body]);

    expect(restarted.read(uuid)).toEqual(session);
    const stored = readFileSync(join(paths.wal, `${uuid}.bodies.jsonl`), "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0);
    expect(stored).toHaveLength(1);
    expect(restarted.bodiesFor([terminal])).toHaveLength(1);
  });

  it("reads and sweeps a body file an earlier retry wrote copies into", () => {
    const paths = scratchPaths();
    const session = minimalSession();
    const uuid = session[0]?.session_uuid as string;
    const terminal = session[session.length - 1] as (typeof session)[number];
    const body: FrameBody = {
      event_id_idem: terminal.event_id_idem,
      session_uuid: uuid,
      seq: terminal.seq,
      content_type: "text/plain; charset=utf-8",
      bytes: new TextEncoder().encode("the sealed turn"),
      content_class: "model_call",
    };
    const wal = new Wal(paths.wal);
    wal.append(session, [body]);
    // What a host upgraded from the previous version holds: the same body
    // line, written again by every retry of the journaled batch.
    const path = join(paths.wal, `${uuid}.bodies.jsonl`);
    const line = readFileSync(path, "utf8")
      .split("\n")
      .filter((text) => text.trim().length > 0)[0] as string;
    appendFileSync(path, `\n${line}\n${line}\n`);

    const reopened = new Wal(paths.wal);
    const read = reopened.bodiesFor([terminal]);
    expect(read).toHaveLength(1);
    expect(
      Buffer.from(read[0]?.bytes_base64 as string, "base64").toString(),
    ).toBe("the sealed turn");
    // A journal written before this change still flushes, and adds nothing.
    reopened.appendRecovered([terminal], [body]);
    // Every copy is swept, not the one the index answers with.
    expect(reopened.dropBodies([terminal])).toBe(3);
    expect(existsSync(path)).toBe(false);
    expect(reopened.bodiesFor([terminal])).toEqual([]);
  });

  it("collects abandoned rewrites only during the writer's compaction scan", () => {
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    const session = minimalSession();
    const uuid = session[0]!.session_uuid;
    wal.append(session);
    wal.markShipped(uuid, -1);
    const bodyPath = join(paths.wal, `${uuid}.bodies.jsonl`);
    writeFileSync(bodyPath, "retained body\n");
    const partial = `${bodyPath}.00000000-0000-4000-8000-000000000001.tmp`;
    const complete = `${bodyPath}.00000000-0000-4000-8000-000000000002.tmp`;
    const unrelated = `${bodyPath}.not-a-rewrite.tmp`;
    for (const path of [partial, complete, unrelated])
      writeFileSync(path, "copy");
    const preserved = [
      bodyPath,
      join(paths.wal, `${uuid}.ndjson`),
      join(paths.wal, "cursor.json"),
      unrelated,
    ];
    const before = preserved.map((path) => readFileSync(path, "utf8"));
    const restarted = new Wal(paths.wal);
    expect(existsSync(partial)).toBe(true);
    expect(restarted.compact(Date.now(), 86_400_000)).toEqual([]);
    expect(existsSync(partial)).toBe(false);
    expect(existsSync(complete)).toBe(false);
    restarted.compact(Date.now(), 86_400_000);
    expect(preserved.map((path) => readFileSync(path, "utf8"))).toEqual(before);
  });

  it("retains evidence and retries when abandoned rewrite cleanup fails", () => {
    const paths = scratchPaths();
    const failures = vi.fn();
    const wal = new Wal(paths.wal, failures);
    const session = minimalSession();
    wal.append(session);
    const tmp = join(
      paths.wal,
      `${session[0]!.session_uuid}.bodies.jsonl.00000000-0000-4000-8000-000000000001.tmp`,
    );
    writeFileSync(tmp, "partial copy");
    const expiredId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const expired = session.map((event) => ({
      ...event,
      session_uuid: expiredId,
    }));
    wal.append(expired);
    wal.markShipped(expiredId, expired.at(-1)!.seq);
    vi.mocked(unlinkSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("cleanup denied"), { code: "EACCES" });
    });
    expect(wal.compact(Date.now() + 1000, 0)).toContain(expiredId);
    expect(existsSync(join(paths.wal, `${expiredId}.ndjson`))).toBe(false);
    expect(failures).toHaveBeenCalledWith({
      session_uuid: session[0]!.session_uuid,
      operation: "cleanup",
      code: "EACCES",
    });
    expect(existsSync(tmp)).toBe(true);
    expect(wal.unshipped(100)).toEqual(session);
    wal.compact(Date.now(), 0);
    expect(existsSync(tmp)).toBe(false);
  });

  it("reads and rewrites bodies without converting the whole file to a string", async () => {
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    const session = minimalSession();
    const uuid = session[0]?.session_uuid as string;
    const path = join(paths.wal, `${uuid}.bodies.jsonl`);
    const stored = session.slice(0, 3).map((event, index) => ({
      event_id_idem: event.event_id_idem,
      seq: event.seq,
      content_type: "text/plain; charset=utf-8",
      bytes_base64: Buffer.from(`${index}:${"x".repeat(90_000)}`).toString(
        "base64",
      ),
    }));
    wal.append(session);
    // Split a multi-byte character at the 64 KiB read boundary. The final
    // record deliberately has no newline, as after an interrupted append.
    const prefix = '{"content_type":"';
    const firstBody = stored[0]!;
    firstBody.content_type = `${"x".repeat(65_536 - prefix.length - 1)}é`;
    const { content_type, ...rest } = firstBody;
    const first = JSON.stringify({ content_type, ...rest });
    writeFileSync(
      path,
      [first, "", ...stored.slice(1).map((body) => JSON.stringify(body))].join(
        "\n",
      ),
    );
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(writeSync).mockImplementationOnce((fd, data) => {
      if (typeof data === "string") throw new Error("expected a buffer");
      return actualFs.writeSync(fd, data, 0, 7);
    });
    const wholeFileRead = vi.mocked(readFileSync);
    wholeFileRead.mockImplementation(() => {
      throw new Error("whole-file read exceeds the string limit");
    });
    try {
      expect(wal.bodiesFor(session)).toEqual(
        stored.map(({ seq: _seq, ...body }) => body),
      );
      expect(wal.read(uuid)).toEqual(session);
      expect(wal.dropBodies(session.slice(1, 2))).toBe(1);
      expect(wal.bodiesFor(session).map((body) => body.event_id_idem)).toEqual([
        stored[0]?.event_id_idem,
        stored[2]?.event_id_idem,
      ]);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(wal.dropBodies(session.slice(1, 2))).toBe(0);
      expect(
        readdirSync(paths.wal).filter((name) => name.endsWith(".tmp")),
      ).toEqual([]);
    } finally {
      wholeFileRead.mockRestore();
    }
  });

  it("reports a streaming read failure and reads bodies on the next attempt", () => {
    const paths = scratchPaths();
    const report = vi.fn();
    const wal = new Wal(paths.wal, report);
    const session = minimalSession();
    const event = session[0];
    if (!event) throw new Error("Missing session event");
    wal.append(session, [
      {
        event_id_idem: event.event_id_idem,
        session_uuid: event.session_uuid,
        seq: event.seq,
        content_type: "text/plain",
        bytes: new TextEncoder().encode("retained body"),
        content_class: "model_call",
      },
    ]);
    vi.mocked(readSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("read failed"), { code: "EIO" });
    });
    expect(() => wal.bodiesFor(session)).toThrow("read failed");
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith({
      session_uuid: event.session_uuid,
      operation: "read",
      code: "EIO",
    });
    expect(wal.bodiesFor(session)).toEqual([
      {
        event_id_idem: event.event_id_idem,
        content_type: "text/plain",
        bytes_base64: Buffer.from("retained body").toString("base64"),
      },
    ]);
  });

  it.each(["write", "sync", "rename"])(
    "keeps the original body file after a %s failure",
    (stage) => {
      const paths = scratchPaths();
      const wal = new Wal(paths.wal);
      const session = minimalSession();
      const uuid = session[0]?.session_uuid as string;
      const path = join(paths.wal, `${uuid}.bodies.jsonl`);
      const original = session
        .slice(0, 2)
        .map((event) =>
          JSON.stringify({
            event_id_idem: event.event_id_idem,
            seq: event.seq,
            content_type: "text/plain",
            bytes_base64: "YQ==",
          }),
        )
        .join("\n");
      writeFileSync(path, original);
      const fail = () => {
        throw new Error("disk full");
      };
      if (stage === "write") vi.mocked(writeSync).mockImplementationOnce(fail);
      if (stage === "sync") vi.mocked(fsyncSync).mockImplementationOnce(fail);
      if (stage === "rename")
        vi.mocked(renameSync).mockImplementationOnce(fail);
      expect(() => wal.dropBodies(session.slice(0, 1))).toThrow("disk full");
      expect(readFileSync(path, "utf8")).toBe(original);
      expect(readdirSync(paths.wal)).toEqual([`${uuid}.bodies.jsonl`]);
    },
  );

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

  it("skips a fully shipped session without reading its file again", () => {
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    const session = minimalSession();
    const uuid = session[0]?.session_uuid as string;
    wal.append(session);
    wal.markShipped(uuid, session[session.length - 1]?.seq as number);
    // The first pass learns the session's last seq. Every pass after it
    // answers from the index, so a host holding hundreds of shipped files
    // does not parse them on each drain and health probe.
    expect(wal.stats().unshipped).toBe(0);
    const read = vi.spyOn(wal, "read");
    expect(wal.unshipped(100)).toEqual([]);
    expect(wal.stats()).toMatchObject({ sessions: 1, unshipped: 0 });
    expect(read).not.toHaveBeenCalled();
  });

  it("computes the unshipped count arithmetically, not by parsing every unshipped event", () => {
    // Tacho collector P1-9: `stats()` used to parse every unshipped event of
    // every session to count them, and the Shipper's `sendBatch` calls it on
    // every batch of a drain — quadratic in the size of a backlog. The count
    // is now `lastSeqOf - shippedThrough`, and only the single oldest
    // unshipped event is ever actually read (for `oldestUnshippedAt`).
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    const session = minimalSession();
    wal.append(session);
    const parse = vi.spyOn(JSON, "parse");
    parse.mockClear();
    const stats = wal.stats();
    expect(stats.unshipped).toBe(session.length);
    expect(stats.oldestUnshippedAt).toBe(session[0]?.ts);
    expect(parse.mock.calls.length).toBeLessThanOrEqual(1);
    parse.mockRestore();
  });

  it("keeps the index current as events arrive after it was filled", () => {
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    const session = minimalSession();
    const uuid = session[0]?.session_uuid as string;
    wal.append(session.slice(0, 2));
    wal.markShipped(uuid, 1);
    expect(wal.unshipped(100)).toEqual([]);
    wal.append(session.slice(2));
    expect(wal.unshipped(100).map((e) => e.seq)).toEqual(
      session.slice(2).map((e) => e.seq),
    );
    expect(wal.stats().unshipped).toBe(session.length - 2);
  });

  it("forgets a compacted session, so a new file under its id is read afresh", () => {
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    const session = minimalSession();
    const uuid = session[0]?.session_uuid as string;
    const last = session[session.length - 1]?.seq as number;
    wal.append(session);
    wal.markShipped(uuid, last);
    expect(wal.stats().unshipped).toBe(0);
    expect(wal.compact(Date.now() + 10 * 86_400_000, 1)).toEqual([uuid]);
    wal.append(session.slice(0, 1));
    expect(wal.unshipped(100).map((e) => e.seq)).toEqual([session[0]?.seq]);
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

  it("sweeps a torn line and a body whose event never arrived", () => {
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
    // a body whose event is not on the chain. That window is real but no sweep
    // can observe it: `append` is two synchronous writes with no await between
    // them and the daemon is single threaded. Seen from here it is an orphan,
    // and no event will ever arrive to judge it against a class. It used to be
    // kept, which kept prompt bytes nothing could ship, erase or compact.
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
    ).toBe(3);
    // All three went — the covered prompt by the mandate, the torn line and the
    // eventless body as orphans — so the file goes with them.
    expect(existsSync(bodyPath)).toBe(false);
  });

  it("sweeps a body file whose session has no event file at all", () => {
    // The orphan `sessions()` cannot see. A crash between `append`'s body
    // write and its first event write leaves `<uuid>.bodies.jsonl` with no
    // `.ndjson` beside it, and `sessions()` lists `.ndjson` only — so the
    // sweep and `compact` both walked straight past it and the bytes outlived
    // every removal path in this class.
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    const uuid = "11111111-1111-4111-8111-111111111111";
    const bodyPath = join(paths.wal, `${uuid}.bodies.jsonl`);
    appendFileSync(
      bodyPath,
      `${JSON.stringify({
        event_id_idem: "evt_orphaned_by_a_crash",
        seq: 1,
        content_type: "text/plain; charset=utf-8",
        bytes_base64: Buffer.from("orphaned prompt").toString("base64"),
      })}\n`,
    );
    expect(wal.sessions()).toEqual([]);

    expect(
      wal.purgeBodiesOutsideMandate({
        mode: "content_exact",
        classes: ["model_call", "tool_call"],
      }),
    ).toBe(1);
    expect(existsSync(bodyPath)).toBe(false);
  });

  it("compacts an orphaned body file once it is older than the window", () => {
    // Belt to the sweep's braces: the sweep runs only when a mandate narrows,
    // so on a host whose mandate never changes an orphan would sit for ever.
    // `compact` ages it on the body file's own mtime, because there is no seal
    // and no shipped cursor to measure against — nothing will ever ship an
    // event that does not exist.
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    const uuid = "22222222-2222-4222-8222-222222222222";
    const bodyPath = join(paths.wal, `${uuid}.bodies.jsonl`);
    appendFileSync(
      bodyPath,
      `${JSON.stringify({
        event_id_idem: "evt_orphaned_by_a_crash",
        seq: 1,
        content_type: "text/plain; charset=utf-8",
        bytes_base64: Buffer.from("orphaned prompt").toString("base64"),
      })}\n`,
    );
    const week = 7 * 24 * 60 * 60_000;
    // Inside the window it stays: an orphan is not urgent, only unbounded.
    expect(wal.compact(Date.now(), week)).toEqual([]);
    expect(existsSync(bodyPath)).toBe(true);
    expect(wal.compact(Date.now() + 10 * 24 * 60 * 60_000, week)).toEqual([
      uuid,
    ]);
    expect(existsSync(bodyPath)).toBe(false);
  });
});

it("skips held sessions without changing their cursor or body access", () => {
  const paths = scratchPaths();
  const wal = new Wal(paths.wal);
  const events = minimalSession();
  wal.append(events);
  expect(wal.unshipped(100, new Set([events[0]!.session_uuid]))).toEqual([]);
  expect(wal.shippedThrough(events[0]!.session_uuid)).toBe(-1);
  expect(wal.unshipped(100)).toEqual(events);
});

describe("restart safety", () => {
  // Tacho collector P0-1: a restart that resealed an already-written seq let
  // ClickHouse's `ReplacingMergeTree` (keyed on seq) silently keep the newer,
  // wrong frame over the original and erase it from the record.
  it("refuses to append an event at or behind a seq this process already wrote", () => {
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    const events = minimalSession();
    wal.append(events);
    const stale = events[0]!;
    expect(() => wal.append([stale])).toThrow(
      /seq 0 is not after the last written seq/,
    );
    // The file on disk is untouched by the refused write.
    expect(wal.read(stale.session_uuid)).toEqual(events);
  });

  it("refuses a stale seq even from a fresh process that has not read the session yet", () => {
    const paths = scratchPaths();
    const events = minimalSession();
    new Wal(paths.wal).append(events);
    // A new `Wal` — the shape of a daemon restart — has an empty in-memory
    // `lastSeq` map and must fall back to a read of the file rather than
    // silently accepting because it has no cached opinion.
    const restarted = new Wal(paths.wal);
    expect(() => restarted.append([events[1]!])).toThrow(
      /not after the last written seq/,
    );
  });

  it("truncates a session's file back to its pre-write size when an append throws", () => {
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    const events = minimalSession();
    wal.append(events.slice(0, 1));
    const path = join(paths.wal, `${events[0]!.session_uuid}.ndjson`);
    const sizeBefore = statSync(path).size;
    vi.mocked(appendFileSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
    });
    expect(() => wal.append([events[1]!])).toThrow(/ENOSPC/);
    expect(statSync(path).size).toBe(sizeBefore);
    // A retry of the same seq succeeds once the transient failure clears.
    wal.append([events[1]!]);
    expect(wal.read(events[0]!.session_uuid)).toEqual(events.slice(0, 2));
  });

  it("repairs a session file whose last line is complete JSON but missing its newline", () => {
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    const events = minimalSession();
    wal.append(events);
    const path = join(paths.wal, `${events[0]!.session_uuid}.ndjson`);
    const original = readFileSync(path, "utf8");
    // A crash right after the content bytes landed but before the trailing
    // newline that closes the line.
    writeFileSync(path, original.replace(/\n$/, ""));
    expect(wal.repairTail(events[0]!.session_uuid)).toBe("terminated");
    expect(wal.read(events[0]!.session_uuid)).toEqual(events);
  });

  it("truncates a session file whose last line never finished writing", () => {
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    const events = minimalSession();
    wal.append(events.slice(0, -1));
    const path = join(paths.wal, `${events[0]!.session_uuid}.ndjson`);
    const sizeBeforeTear = statSync(path).size;
    appendFileSync(
      path,
      JSON.stringify(events[events.length - 1]).slice(0, 40),
    );
    expect(wal.repairTail(events[0]!.session_uuid)).toBe("truncated");
    expect(statSync(path).size).toBe(sizeBeforeTear);
    expect(wal.read(events[0]!.session_uuid)).toEqual(events.slice(0, -1));
    // The repaired chain accepts a fresh seal of the event the tear lost.
    wal.append([events[events.length - 1]!]);
    expect(wal.read(events[0]!.session_uuid)).toEqual(events);
  });

  it("reads the last event from the tail without a torn line to repair first", () => {
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    const events = minimalSession();
    wal.append(events);
    const last = events[events.length - 1]!;
    expect(wal.lastEvent(last.session_uuid)).toEqual(last);
  });

  it("answers no last event for a session whose tail is still torn", () => {
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    const events = minimalSession();
    wal.append(events);
    const path = join(paths.wal, `${events[0]!.session_uuid}.ndjson`);
    appendFileSync(path, JSON.stringify(events[0]).slice(0, 10));
    expect(wal.lastEvent(events[0]!.session_uuid)).toBeUndefined();
  });
});

describe("orphan bodies", () => {
  // #3372 finding 2: `append` wrote bodies before it checked or wrote the
  // events. A batch whose events did not land left its body behind under an
  // `event_id_idem` the next event at that seq reuses, and the index served
  // the first line for an id, so the next event shipped the orphan and ingest
  // refused it as a digest mismatch.
  const bodyFor = (
    event: { event_id_idem: string; session_uuid: string; seq: number },
    text: string,
  ): FrameBody => ({
    event_id_idem: event.event_id_idem,
    session_uuid: event.session_uuid,
    seq: event.seq,
    content_type: "text/plain; charset=utf-8",
    bytes: new TextEncoder().encode(text),
    content_class: "model_call",
  });
  const served = (wal: Wal, event: Parameters<Wal["bodiesFor"]>[0][number]) =>
    wal
      .bodiesFor([event])
      .map((body) => Buffer.from(body.bytes_base64, "base64").toString("utf8"));

  it("writes no body for a batch refused for a stale seq", () => {
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    const events = minimalSession();
    const first = events[0]!;
    wal.append(events, [bodyFor(first, "the prompt that was sent")]);
    const bodyPath = join(paths.wal, `${first.session_uuid}.bodies.jsonl`);
    const sizeBefore = statSync(bodyPath).size;
    expect(() =>
      wal.append([first], [bodyFor(first, "a stale reseal's prompt")]),
    ).toThrow(/not after the last written seq/);
    expect(statSync(bodyPath).size).toBe(sizeBefore);
    expect(served(wal, first)).toEqual(["the prompt that was sent"]);
  });

  it("takes a batch's bodies back out when its events fail to write", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    const events = minimalSession();
    const [first, second] = events as [
      (typeof events)[number],
      (typeof events)[number],
    ];
    wal.append([first]);
    // The body write lands and the event write after it fails.
    vi.mocked(appendFileSync)
      .mockImplementationOnce(actual.appendFileSync)
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
      });
    expect(() =>
      wal.append([second], [bodyFor(second, "the call that never landed")]),
    ).toThrow(/ENOSPC/);
    const bodyPath = join(paths.wal, `${first.session_uuid}.bodies.jsonl`);
    expect(existsSync(bodyPath)).toBe(false);
    // The recorder rolled its seal back, so the next event takes the same seq
    // and the same event id. It ships its own body.
    wal.append([second], [bodyFor(second, "the call that did land")]);
    expect(served(wal, second)).toEqual(["the call that did land"]);
  });

  it("serves the later body when a crash left an orphan under the same event id", () => {
    const paths = scratchPaths();
    const events = minimalSession();
    const [first, second] = events as [
      (typeof events)[number],
      (typeof events)[number],
    ];
    new Wal(paths.wal).append([first]);
    // The process died between the body write and the event write.
    const bodyPath = join(paths.wal, `${first.session_uuid}.bodies.jsonl`);
    appendFileSync(
      bodyPath,
      `${JSON.stringify({
        event_id_idem: second.event_id_idem,
        seq: second.seq,
        content_type: "text/plain; charset=utf-8",
        bytes_base64: Buffer.from("the orphan").toString("base64"),
      })}\n`,
    );
    const restarted = new Wal(paths.wal);
    restarted.append([second], [bodyFor(second, "the resealed call")]);
    expect(served(restarted, second)).toEqual(["the resealed call"]);
    // The persisted index answers the same way after another restart.
    expect(served(new Wal(paths.wal), second)).toEqual(["the resealed call"]);
  });

  it("rebuilds a sidecar an earlier build wrote, which kept the orphan's line", () => {
    const paths = scratchPaths();
    const events = minimalSession();
    const [first, second] = events as [
      (typeof events)[number],
      (typeof events)[number],
    ];
    const wal = new Wal(paths.wal);
    wal.append([first]);
    const bodyPath = join(paths.wal, `${first.session_uuid}.bodies.jsonl`);
    const stored = (text: string) =>
      JSON.stringify({
        event_id_idem: second.event_id_idem,
        seq: second.seq,
        content_type: "text/plain; charset=utf-8",
        bytes_base64: Buffer.from(text).toString("base64"),
      });
    // An orphan, then the body of the event that took its seq.
    writeFileSync(
      bodyPath,
      `${stored("the orphan")}\n${stored("the resealed call")}\n`,
    );
    wal.append([second]);
    // Version 1 kept the first line for an event id, and its `through`
    // covered both, so a load that trusted it served the orphan.
    writeFileSync(
      join(paths.wal, `${first.session_uuid}.bodies.index`),
      [
        JSON.stringify(["tacho/bodies-index", 1]),
        JSON.stringify([
          second.event_id_idem,
          0,
          Buffer.byteLength(stored("the orphan")),
        ]),
        JSON.stringify(["through", statSync(bodyPath).size]),
        "",
      ].join("\n"),
    );
    expect(served(new Wal(paths.wal), second)).toEqual(["the resealed call"]);
  });

  // A crash between the body write and the event write left the body behind.
  // The restarted recorder seals its next event at the same seq, and when
  // that event wrote no body, the orphan was served for it. Retention kept
  // it too, because its event id is then on the chain.
  const crashOrphan = (
    walDir: string,
    event: { event_id_idem: string; session_uuid: string; seq: number },
    text: string,
    { torn = false } = {},
  ) => {
    const line = JSON.stringify({
      event_id_idem: event.event_id_idem,
      seq: event.seq,
      content_type: "text/plain; charset=utf-8",
      bytes_base64: Buffer.from(text).toString("base64"),
    });
    appendFileSync(
      join(walDir, `${event.session_uuid}.bodies.jsonl`),
      torn ? `\n${line.slice(0, 40)}` : `\n${line}\n`,
    );
  };

  it("cuts a crash orphan at startup, so the event that takes its seq serves no body", () => {
    const paths = scratchPaths();
    const events = minimalSession();
    const [first, second, third] = events as [
      (typeof events)[number],
      (typeof events)[number],
      (typeof events)[number],
    ];
    new Wal(paths.wal).append([first], [bodyFor(first, "the first prompt")]);
    crashOrphan(paths.wal, second, "the orphan");
    crashOrphan(paths.wal, third, "a torn write", { torn: true });
    const restarted = new Wal(paths.wal);
    expect(restarted.repairOrphanBodies()).toBe(2);
    restarted.append([second]);
    expect(served(restarted, second)).toEqual([]);
    expect(served(restarted, first)).toEqual(["the first prompt"]);
    const bodyPath = join(paths.wal, `${first.session_uuid}.bodies.jsonl`);
    expect(readFileSync(bodyPath, "utf8")).not.toContain(
      Buffer.from("the orphan").toString("base64"),
    );
  });

  it("keeps every body whose event is on disk, including a retried batch's", () => {
    const paths = scratchPaths();
    const events = minimalSession();
    const [first, second] = events as [
      (typeof events)[number],
      (typeof events)[number],
    ];
    const wal = new Wal(paths.wal);
    wal.append([first, second], [bodyFor(second, "the second call")]);
    // A journal retry writes a body for an event already on disk, after the
    // bodies of later batches.
    wal.appendRecovered([first], [bodyFor(first, "the first prompt")]);
    const bodyPath = join(paths.wal, `${first.session_uuid}.bodies.jsonl`);
    const before = readFileSync(bodyPath, "utf8");
    expect(new Wal(paths.wal).repairOrphanBodies()).toBe(0);
    expect(readFileSync(bodyPath, "utf8")).toBe(before);
  });

  it("removes a body file whose session has no event on disk", () => {
    const paths = scratchPaths();
    const [first] = minimalSession() as [ReturnType<typeof minimalSession>[0]];
    new Wal(paths.wal);
    crashOrphan(paths.wal, first, "the only body");
    const wal = new Wal(paths.wal);
    expect(wal.repairOrphanBodies()).toBe(1);
    expect(
      existsSync(join(paths.wal, `${first.session_uuid}.bodies.jsonl`)),
    ).toBe(false);
    wal.append([first]);
    expect(served(wal, first)).toEqual([]);
  });
});

describe("group commit", () => {
  // Tacho collector P1-6/P1-7: a body write failure was swallowed, so a
  // sealed event persisted with content the store never received, and WAL
  // files were never fsynced, so a cursor written durably (state.json,
  // cursor.json) could outrun bytes that a crash then lost from the page
  // cache.
  it("throws when a body write fails, instead of persisting the event over lost content", () => {
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    const events = minimalSession();
    const body: FrameBody = {
      event_id_idem: events[0]!.event_id_idem,
      session_uuid: events[0]!.session_uuid,
      seq: 0,
      content_type: "text/plain; charset=utf-8",
      bytes: new TextEncoder().encode("prompt bytes"),
      content_class: "model_call",
    };
    vi.mocked(appendFileSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
    });
    expect(() => wal.append(events, [body])).toThrow(/ENOSPC/);
    // Neither the body nor the event it belongs to landed.
    expect(wal.read(events[0]!.session_uuid)).toEqual([]);
  });

  it("does not fsync until flush is called, then fsyncs every file touched since the last flush", () => {
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    const events = minimalSession();
    const before = vi.mocked(fdatasyncSync).mock.calls.length;
    wal.append(events.slice(0, -1));
    expect(vi.mocked(fdatasyncSync).mock.calls.length).toBe(before);
    wal.flush();
    expect(vi.mocked(fdatasyncSync).mock.calls.length).toBeGreaterThan(before);
    const afterFirstFlush = vi.mocked(fdatasyncSync).mock.calls.length;
    // A second flush with nothing new appended has nothing to sync.
    wal.flush();
    expect(vi.mocked(fdatasyncSync).mock.calls.length).toBe(afterFirstFlush);
  });

  it("flushes the WAL before persisting the shipped/sealed cursor", () => {
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    const events = minimalSession();
    vi.mocked(fdatasyncSync).mockClear();
    vi.mocked(writeSync).mockClear();
    wal.append(events); // includes agent_stop, so this call persists the cursor
    const fdatasyncOrders = vi.mocked(fdatasyncSync).mock.invocationCallOrder;
    // `writeSensitiveFileAtomic` is the only caller of `writeSync` on this
    // path (cursor.json's atomic write); the event and body files go through
    // `appendFileSync`, which does not call the exported `writeSync`.
    const cursorWriteOrders = vi.mocked(writeSync).mock.invocationCallOrder;
    expect(fdatasyncOrders.length).toBeGreaterThan(0);
    expect(cursorWriteOrders.length).toBeGreaterThan(0);
    expect(Math.max(...fdatasyncOrders)).toBeLessThan(
      Math.min(...cursorWriteOrders),
    );
  });
});
