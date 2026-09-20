import { appendFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Shipper } from "../collector/spool";
import type { ControlClient } from "./control-client";
import type { FrameBody } from "../evidence/frame-body";
import { minimalSession } from "../test-helpers";
import { scratchPaths } from "./test-support";
import { Wal } from "./wal";

const fault = vi.hoisted(() => ({
  partialBodyWrite: false,
  wholeBodyReadForbidden: false,
  bodyReadFailure: false,
  bodyReads: 0,
  bodyFds: new Set<number>(),
}));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      const fd = fs.openSync(...args);
      if (String(args[0]).endsWith(".bodies.jsonl")) fault.bodyFds.add(fd);
      return fd;
    },
    closeSync: (fd: number) => {
      fault.bodyFds.delete(fd);
      return fs.closeSync(fd);
    },
    readSync: (...args: Parameters<typeof fs.readSync>) => {
      if (fault.bodyReadFailure && fault.bodyFds.has(args[0])) {
        fault.bodyReads += 1;
        if (fault.bodyReads > 1) {
          throw Object.assign(new Error("body read interrupted"), {
            code: "EIO",
          });
        }
      }
      return fs.readSync(...args);
    },
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
      if (
        fault.wholeBodyReadForbidden &&
        String(args[0]).endsWith(".bodies.jsonl")
      ) {
        throw new Error("whole-file body read exceeds the string limit");
      }
      return fs.readFileSync(...args);
    },
    appendFileSync: (...args: Parameters<typeof fs.appendFileSync>) => {
      if (fault.partialBodyWrite && String(args[0]).endsWith(".bodies.jsonl")) {
        fault.partialBodyWrite = false;
        fs.appendFileSync(args[0], String(args[1]).slice(0, 30), args[2]);
        throw Object.assign(new Error("disk failed during body append"), {
          code: "ENOSPC",
        });
      }
      return fs.appendFileSync(...args);
    },
  };
});
afterEach(() => {
  fault.partialBodyWrite = false;
  fault.wholeBodyReadForbidden = false;
  fault.bodyReadFailure = false;
  fault.bodyReads = 0;
  fault.bodyFds.clear();
});

function setup() {
  const paths = scratchPaths();
  const session = minimalSession();
  const uuid = session[0]?.session_uuid as string;
  const report = vi.fn();
  const wal = new Wal(paths.wal, report);
  const bodyPath = join(paths.wal, `${uuid}.bodies.jsonl`);
  const body = (index: number): FrameBody => ({
    event_id_idem: session[index]?.event_id_idem as string,
    session_uuid: uuid,
    seq: session[index]?.seq as number,
    content_type: "text/plain",
    bytes: new TextEncoder().encode(`retained body ${index}`),
    content_class: "model_call",
  });
  return { paths, session, uuid, report, wal, bodyPath, body };
}

describe("WAL body failure isolation", () => {
  it("streams bodies across read chunks while skipping malformed records", () => {
    const { session, report, wal, bodyPath, body } = setup();
    const largeBody = {
      ...body(0),
      bytes: new TextEncoder().encode("retained content é".repeat(10_000)),
    };
    wal.append(session.slice(0, 1), [largeBody]);
    appendFileSync(bodyPath, "{broken\n");
    wal.append(session.slice(1), [body(1)]);
    fault.wholeBodyReadForbidden = true;
    expect(wal.bodiesFor(session)).toEqual(
      [largeBody, body(1)].map((entry) => ({
        event_id_idem: entry.event_id_idem,
        content_type: entry.content_type,
        bytes_base64: Buffer.from(entry.bytes).toString("base64"),
      })),
    );
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith({
      session_uuid: session[0]?.session_uuid,
      operation: "read",
      code: "invalid_body_record",
    });
  });

  it("keeps the entire batch unshipped after a later body read fails, then retries intact", async () => {
    const { paths, session, uuid, report, wal, body } = setup();
    const first = session[0];
    if (!first) throw new Error("Missing session fixture");
    const foreign = {
      ...first,
      session_uuid: "00000000-0000-0000-0000-000000000001",
      event_id_idem: "foreign-event",
      agent: { ...first.agent, host_enrollment_id: "previous-enrollment" },
    };
    const bodies = [
      body(2),
      {
        ...body(5),
        bytes: new TextEncoder().encode("large body".repeat(20_000)),
      },
    ];
    wal.append([foreign, ...session], bodies);
    mkdirSync(join(paths.wal, `${foreign.session_uuid}.bodies.jsonl`));
    const pending = wal.unshipped(100);
    const markShipped = vi.spyOn(wal, "markShipped");
    const ingest = vi.fn().mockResolvedValue({
      accepted: session.length,
      event_ids: [],
      chain_breaks: [],
      control: {
        host_status: "active",
        deny_generation: { org: 1, workspace: 1 },
        bundle_etag: "e",
        commands: [],
      },
    });
    const shipper = new Shipper({
      wal,
      client: { ingest } as unknown as ControlClient,
      quarantineDir: join(paths.wal, "quarantine-test"),
      hostEnrollmentId: first.agent.host_enrollment_id,
      health: () => ({ version: "1" }),
      onControl: () => {},
      retentionInForce: () => ({
        mandate: { mode: "content_exact", classes: ["model_call"] },
        proven: true,
      }),
      log: () => {},
      now: () => 0,
    });
    fault.bodyReadFailure = true;
    await expect(shipper.drain()).rejects.toMatchObject({ code: "EIO" });
    expect(fault.bodyReads).toBe(2);
    expect(ingest).not.toHaveBeenCalled();
    expect(markShipped).not.toHaveBeenCalled();
    expect(new Wal(paths.wal).unshipped(100)).toEqual(pending);
    expect(report).toHaveBeenCalledWith({
      session_uuid: uuid,
      operation: "read",
      code: "EIO",
    });
    fault.bodyReadFailure = false;
    await expect(shipper.drain()).resolves.toMatchObject({
      shipped: session.length,
      quarantined: 1,
    });
    expect(ingest).toHaveBeenCalledOnce();
    expect(ingest).toHaveBeenCalledWith(
      session,
      { version: "1" },
      bodies.map((entry) => ({
        event_id_idem: entry.event_id_idem,
        content_type: entry.content_type,
        bytes_base64: Buffer.from(entry.bytes).toString("base64"),
      })),
    );
    expect(new Wal(paths.wal).unshipped(100)).toEqual([]);
  });

  it("persists sealed events when the actual body path is unwritable and later resumes body storage", () => {
    const { paths, session, uuid, report, wal, bodyPath, body } = setup();
    mkdirSync(bodyPath);
    wal.append(session.slice(0, 2), [body(1)]);
    expect(wal.read(uuid)).toEqual(session.slice(0, 2));
    expect(() => wal.bodiesFor(session.slice(0, 2))).toThrow();
    expect(report).toHaveBeenCalledWith({
      session_uuid: uuid,
      operation: "append",
      code: "EISDIR",
    });
    expect(report).toHaveBeenCalledWith({
      session_uuid: uuid,
      operation: "read",
      code: "EISDIR",
    });
    rmSync(bodyPath, { recursive: true });
    const restarted = new Wal(paths.wal, report);
    restarted.append(session.slice(2), [body(2)]);
    expect(restarted.unshipped(100)).toEqual(session);
    expect(
      restarted.bodiesFor(session).map((value) => value.event_id_idem),
    ).toEqual([body(2).event_id_idem]);
    restarted.markShipped(uuid, session.at(-1)?.seq as number);
    expect(new Wal(paths.wal, report).unshipped(100)).toEqual([]);
  });

  it("keeps prior and later bodies readable around an actual partial append after restart", () => {
    const { paths, session, uuid, report, wal, bodyPath, body } = setup();
    wal.append(session.slice(0, 1), [body(0)]);
    fault.partialBodyWrite = true;
    wal.append(session.slice(1, 2), [body(1)]);
    expect(readFileSync(bodyPath, "utf8").endsWith("\n")).toBe(false);
    expect(report).toHaveBeenCalledWith({
      session_uuid: uuid,
      operation: "append",
      code: "ENOSPC",
    });
    const restarted = new Wal(paths.wal, report);
    restarted.append(session.slice(2), [body(2)]);
    expect(restarted.read(uuid)).toEqual(session);
    expect(
      restarted.bodiesFor(session).map((value) => value.event_id_idem),
    ).toEqual([body(0).event_id_idem, body(2).event_id_idem]);
    expect(report).toHaveBeenCalledWith({
      session_uuid: uuid,
      operation: "read",
      code: "invalid_body_record",
    });
    expect(restarted.dropBodies([session[0] as (typeof session)[number]])).toBe(
      2,
    );
    expect(restarted.bodiesFor(session)).toHaveLength(1);
  });

  it("reports malformed records once per session read", () => {
    const { session, report, wal, bodyPath } = setup();
    appendFileSync(bodyPath, "{broken\nnull\n{another\n");
    expect(wal.bodiesFor(session)).toEqual([]);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("does not let a failing diagnostic sink block event persistence", () => {
    const { paths, session, uuid, bodyPath, body } = setup();
    mkdirSync(bodyPath);
    const wal = new Wal(paths.wal, () => {
      throw new Error("logger unavailable");
    });
    expect(() => wal.append(session, [body(1)])).not.toThrow();
    expect(wal.read(uuid)).toEqual(session);
  });

  it("keeps event corruption visible rather than skipping a broken chain", () => {
    const { paths, session, uuid, wal } = setup();
    wal.append(session);
    appendFileSync(join(paths.wal, `${uuid}.ndjson`), "{torn-event");
    expect(() => wal.read(uuid)).toThrow();
  });
});
