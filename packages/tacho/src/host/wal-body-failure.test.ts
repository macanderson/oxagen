import { appendFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FrameBody } from "../evidence/frame-body";
import { minimalSession } from "../test-helpers";
import { scratchPaths } from "./test-support";
import { Wal } from "./wal";

const fault = vi.hoisted(() => ({
  partialBodyWrite: false,
  refuseWholeBodyRead: false,
}));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
      if (
        fault.refuseWholeBodyRead &&
        String(args[0]).endsWith(".bodies.jsonl")
      ) {
        throw new Error(
          "Whole body-file reads are forbidden in this regression",
        );
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
  fault.refuseWholeBodyRead = false;
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
  it("persists sealed events when the actual body path is unwritable and later resumes body storage", () => {
    const { paths, session, uuid, report, wal, bodyPath, body } = setup();
    mkdirSync(bodyPath);
    wal.append(session.slice(0, 2), [body(1)]);
    expect(wal.read(uuid)).toEqual(session.slice(0, 2));
    expect(wal.bodiesFor(session.slice(0, 2))).toEqual([]);
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

  it("streams body records across chunk boundaries while skipping a torn record", () => {
    const { session, wal, bodyPath, body, report } = setup();
    const large = {
      ...body(0),
      bytes: new TextEncoder().encode("λ".repeat(90_000)),
    };
    wal.append(session.slice(0, 1), [large]);
    appendFileSync(bodyPath, "{torn-body\n");
    wal.append(session.slice(1), [body(1)]);
    fault.refuseWholeBodyRead = true;
    const restored = wal.bodiesFor(session);
    expect(restored.map((entry) => entry.event_id_idem)).toEqual([
      large.event_id_idem,
      body(1).event_id_idem,
    ]);
    expect(Buffer.from(restored[0]?.bytes_base64 ?? "", "base64")).toEqual(
      Buffer.from(large.bytes),
    );
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ code: "invalid_body_record" }),
    );
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
