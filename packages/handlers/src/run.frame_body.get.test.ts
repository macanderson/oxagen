import { isHandlerError } from "@oxagen/oxagen/handler-error";
import { runFrameBodyGet } from "@oxagen/oxagen/contracts/run.frame_body.get";
import type {
  AttemptEventReadRecord,
  FrameBodyColumns,
} from "@oxagen/run-ledger";
import { digestBytes } from "@oxagen/tacho";
import type { TachoFrameRow } from "@oxagen/telemetry";
import { describe, expect, it, vi } from "vitest";
import {
  createRunFrameBodyGetHandler,
  type RunFrameBodyGetDeps,
} from "./run.frame_body.get";
import {
  ctx,
  event,
  ledgerRun,
  memoryEvents,
  memoryStores,
  memorySubagentFrames,
  memoryTachoFrames,
  summary,
  tachoRow,
  tachoSession,
} from "./run.test-support";

const RUN_UUID = "0192d4a8-7c1e-7a00-8000-0000000000a1";
const LEDGER_ID = "arun_5f0c2e9a1b7d4c3e8f6a02";
const TACHO_ID = "tse_4q8r1t6v3x5z0b2d7h2k9m";
const SESSION_UUID = "0192d4a8-7c1e-7a00-8000-00000000c0de";
/** A subagent chain under the run's root session. */
const CHILD_UUID = "0192d4a8-7c1e-7a00-8000-00000000c1d0";
/** A subagent chain under another run's root, in the same workspace. */
const OTHER_ROOT = "0192d4a8-7c1e-7a00-8000-00000000d0de";
const FOREIGN_UUID = "0192d4a8-7c1e-7a00-8000-00000000d1d0";

const enc = new TextEncoder();
const BODY = enc.encode('{"prompt":"deploy"}');
const DIGEST = digestBytes(BODY);
const REF = `evb:v1:k:${DIGEST.slice(7)}`;
const REMOVED = digestBytes(enc.encode("removed"));

function harness(over: {
  events?: AttemptEventReadRecord[];
  tachoRows?: TachoFrameRow[];
  /** Subagent chains' rows, of this run and of others. */
  chainRows?: TachoFrameRow[];
  /** What the store answers for REF; defaults to BODY. */
  stored?: Uint8Array;
}) {
  const stores = memoryStores(
    [ledgerRun({ publicId: LEDGER_ID, runId: RUN_UUID })],
    [tachoSession({ publicId: TACHO_ID })],
  );
  const getBody = vi.fn((_scope: unknown, ref: string) => {
    if (ref !== REF) return Promise.reject(new Error(`no object for ${ref}`));
    return Promise.resolve({
      bytes: over.stored ?? BODY,
      contentType: "application/json",
      digestHex: DIGEST.slice(7),
    });
  });
  const deps: RunFrameBodyGetDeps = {
    queries: stores.queries,
    store: {
      getRunByPublicId: (id) =>
        Promise.resolve(id === LEDGER_ID ? summary() : null),
      readAttemptEventsSince: memoryEvents(over.events ?? []),
    },
    readRunRollups: stores.readRunRollups,
    readWitnessFor: stores.readWitnessFor,
    tachoFrames: memoryTachoFrames(SESSION_UUID, over.tachoRows ?? []),
    tachoSubagentFrames: vi.fn(memorySubagentFrames(over.chainRows ?? [])),
    bodies: { getBody },
  };
  return {
    get: createRunFrameBodyGetHandler(deps),
    getBody,
    chains: deps.tachoSubagentFrames,
  };
}

/** A frame on a subagent chain: `session` under `root`. */
function chainRow(
  seq: number,
  session: string,
  root: string,
  over: Partial<TachoFrameRow> = {},
): TachoFrameRow {
  return tachoRow(seq, {
    sessionUuid: session,
    rootSessionUuid: root,
    parentSessionUuid: root,
    subagentId: "agent-1",
    subagentType: "Explore",
    spawnToolUseId: "toolu_task",
    ...over,
  });
}

const retained: FrameBodyColumns = {
  bodyRef: REF,
  bodyDigest: DIGEST,
  bodyBytes: BODY.byteLength,
  redactions: [{ path: "bytes:0-4", reason: "jwt", original_digest: REMOVED }],
  fidelity: "full",
};

describe("get_run_frame_body", () => {
  it("answers a retained ledger body as base64 with its content type, digest and redactions", async () => {
    const { get, getBody } = harness({
      events: [event(1), event(2, { body: retained })],
    });
    const out = await get({ runId: LEDGER_ID, seq: "2" }, ctx());
    expect(runFrameBodyGet.output.parse(out)).toEqual(out);
    expect(out).toEqual({
      contentType: "application/json",
      bytes: Buffer.from(BODY).toString("base64"),
      digest: DIGEST,
      redactions: [
        { path: "bytes:0-4", reason: "jwt", originalDigest: REMOVED },
      ],
    });
    expect(getBody).toHaveBeenCalledWith(
      { orgId: ctx().orgId, workspaceId: ctx().workspaceId },
      REF,
    );
  });

  it("answers a wrapped frame's body the same way, located by its dense seq", async () => {
    const { get } = harness({
      tachoRows: [
        tachoRow(0, { kind: "agent_start" }),
        tachoRow(1, { contentDigest: DIGEST, bytesRef: REF }),
      ],
    });
    const out = await get({ runId: TACHO_ID, seq: "1" }, ctx());
    expect(out.bytes).toBe(Buffer.from(BODY).toString("base64"));
    expect(out.digest).toBe(DIGEST);
  });

  it("answers the digest and no bytes under digest_only, without touching the store", async () => {
    const { get, getBody } = harness({
      events: [
        event(1, {
          body: { ...retained, bodyRef: null, fidelity: "digest_only" },
        }),
      ],
    });
    const out = await get({ runId: LEDGER_ID, seq: "1" }, ctx());
    expect(out).toMatchObject({
      contentType: null,
      bytes: null,
      digest: DIGEST,
    });
    expect(getBody).not.toHaveBeenCalled();
  });

  it("is not_found for a frame that carried no content, a seq past the end, and a run outside the workspace (negative)", async () => {
    const { get } = harness({ events: [event(1)] });
    await expect(get({ runId: LEDGER_ID, seq: "1" }, ctx())).rejects.toSatisfy(
      (e) => isHandlerError(e) && e.reason === "frame_has_no_body",
    );
    await expect(get({ runId: LEDGER_ID, seq: "9" }, ctx())).rejects.toSatisfy(
      (e) => isHandlerError(e) && e.reason === "frame_not_found",
    );
    await expect(
      get({ runId: "arun_unknown", seq: "1" }, ctx()),
    ).rejects.toSatisfy(
      (e) => isHandlerError(e) && e.reason === "run_not_found",
    );
  });

  it("refuses bytes that do not hash to the recorded digest (negative)", async () => {
    const { get } = harness({
      events: [event(1, { body: retained })],
      stored: enc.encode('{"prompt":"tampered"}'),
    });
    await expect(get({ runId: LEDGER_ID, seq: "1" }, ctx())).rejects.toThrow(
      /does not hash to the recorded digest/,
    );
  });

  describe("a subagent's frame (#3823)", () => {
    // The run's own frame 0 carried nothing, and the subagent's frame 0 kept
    // a body, so a read that fell back to the run's chain answers
    // frame_has_no_body rather than the bytes.
    const tachoRows = [tachoRow(0, { kind: "agent_start" }), tachoRow(1)];
    const chainRows = [
      chainRow(0, CHILD_UUID, SESSION_UUID, {
        contentDigest: DIGEST,
        bytesRef: REF,
      }),
      chainRow(1, CHILD_UUID, SESSION_UUID),
      chainRow(2, CHILD_UUID, SESSION_UUID, {
        contentDigest: DIGEST,
        bytesRef: REF,
      }),
      chainRow(0, FOREIGN_UUID, OTHER_ROOT, {
        contentDigest: DIGEST,
        bytesRef: REF,
      }),
    ];

    it("opens the chain's first frame, seq 0, by its chain and seq", async () => {
      const { get, chains } = harness({ tachoRows, chainRows });
      const out = await get(
        { runId: TACHO_ID, seq: "0", sessionUuid: CHILD_UUID },
        ctx(),
      );
      expect(runFrameBodyGet.output.parse(out)).toEqual(out);
      expect(out.bytes).toBe(Buffer.from(BODY).toString("base64"));
      expect(out.digest).toBe(DIGEST);
      // One bounded read of the one chain, fenced to the run's root. Seq 0
      // has no position below it, so the read starts at the chain's head.
      expect(chains).toHaveBeenCalledWith({
        rootSessionUuid: SESSION_UUID,
        sessionUuids: [CHILD_UUID],
        after: null,
        throughSeq: 0,
        limit: 1,
      });
    });

    it("opens a later frame of the chain from just below it", async () => {
      const { get, chains } = harness({ tachoRows, chainRows });
      const out = await get(
        { runId: TACHO_ID, seq: "2", sessionUuid: CHILD_UUID },
        ctx(),
      );
      expect(out.digest).toBe(DIGEST);
      expect(chains).toHaveBeenCalledWith({
        rootSessionUuid: SESSION_UUID,
        sessionUuids: [CHILD_UUID],
        after: { sessionUuid: CHILD_UUID, seq: 1 },
        throughSeq: 2,
        limit: 1,
      });
    });

    it("reads the run's own chain by seq alone, and by the run's own session", async () => {
      const { get, chains } = harness({ tachoRows, chainRows });
      await expect(
        get({ runId: TACHO_ID, seq: "0" }, ctx()),
      ).rejects.toSatisfy(
        (e) => isHandlerError(e) && e.reason === "frame_has_no_body",
      );
      await expect(
        get({ runId: TACHO_ID, seq: "0", sessionUuid: SESSION_UUID }, ctx()),
      ).rejects.toSatisfy(
        (e) => isHandlerError(e) && e.reason === "frame_has_no_body",
      );
      expect(chains).not.toHaveBeenCalled();
    });

    it("is not_found for a seq the chain does not hold (negative)", async () => {
      const { get } = harness({ tachoRows, chainRows });
      await expect(
        get({ runId: TACHO_ID, seq: "7", sessionUuid: CHILD_UUID }, ctx()),
      ).rejects.toSatisfy(
        (e) => isHandlerError(e) && e.reason === "frame_not_found",
      );
    });

    it("is not_found for a chain of another run, though its frame kept a body (negative)", async () => {
      // The contract is high sensitivity: a run id the caller may read must
      // not open a frame of a run it names only by session.
      const { get, chains } = harness({ tachoRows, chainRows });
      await expect(
        get({ runId: TACHO_ID, seq: "0", sessionUuid: FOREIGN_UUID }, ctx()),
      ).rejects.toSatisfy(
        (e) => isHandlerError(e) && e.reason === "frame_not_found",
      );
      expect(chains).toHaveBeenCalledWith(
        expect.objectContaining({ rootSessionUuid: SESSION_UUID }),
      );
    });

    it("is not_found for any session on a ledger run, which has one chain (negative)", async () => {
      const { get, chains } = harness({
        events: [event(1, { body: retained })],
        chainRows,
      });
      await expect(
        get({ runId: LEDGER_ID, seq: "1", sessionUuid: CHILD_UUID }, ctx()),
      ).rejects.toSatisfy(
        (e) => isHandlerError(e) && e.reason === "frame_not_found",
      );
      expect(chains).not.toHaveBeenCalled();
    });
  });
});
