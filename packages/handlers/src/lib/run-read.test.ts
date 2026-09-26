/**
 * The handlers' ledger wiring (`ledgerStore`, `defaultRunReadDeps`) against
 * a run whose attempt was compacted: the frames must come back from the
 * archive segment through the process-wide evidence store, resolved at the
 * read and never at construction.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  storage: vi.fn(),
  objectGet: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});

// The storage driver behind the process-wide evidence store: opening it is
// the environment-bound step the deferred archive keeps out of construction.
vi.mock("@oxagen/storage", () => ({
  storage: () => mocks.storage(),
}));

import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { makeWithTenantDbMock } from "@oxagen/database";
import {
  archiveFrameOf,
  readRunChains,
  type SealedFrameRow,
} from "@oxagen/run-ledger";
import { buildArchiveSegment } from "@oxagen/tacho";
import {
  defaultRunReadDeps,
  readFrameAt,
  readFrames,
  type ResolvedRun,
  runChainReads,
  type RunReadDeps,
} from "./run-read";
import { tachoRow } from "../run.test-support";

const UUID_RUN = "33333333-3333-4333-8333-333333333333";
const UUID_ATTEMPT = "44444444-4444-4444-8444-444444444444";
const SHA_1 = `sha256:${"1".repeat(64)}`;
const SHA_2 = `sha256:${"2".repeat(64)}`;

function sealedRow(runSeq: string, eventDigest: string): SealedFrameRow {
  return {
    id: `0192d4a8-7c1e-7a00-8000-00000000000${runSeq}`,
    attempt_seq: Number(runSeq),
    run_seq: runSeq,
    event_schema_version: "2",
    event_type: "tool.call_completed",
    stage: "tool",
    payload_digest: SHA_1,
    event_digest: eventDigest,
    payload_inline: { tool_call_id: `call_${runSeq}` },
    encrypted_payload_ref: null,
    observed_at: "2026-09-11T10:00:00.000Z",
    created_at: "2026-09-11T10:00:00.500Z",
    body_ref: null,
    body_digest: null,
    body_bytes: null,
    redactions: null,
    fidelity: "digest_only",
  };
}

const run: ResolvedRun = {
  source: "ledger",
  runId: UUID_RUN,
  row: {} as never,
  record: {} as never,
  item: {} as never,
  witnessFor: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("defaultRunReadDeps: a compacted attempt", () => {
  it("reads the frames back from the archive segment through the evidence store", async () => {
    const segment = buildArchiveSegment(
      [sealedRow("1", SHA_1), sealedRow("2", SHA_2)].map(archiveFrameOf),
    );
    const ref = `evidence/segment/${segment.segmentDigest.slice(7)}`;
    mocks.objectGet.mockResolvedValue({
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(segment.bytes);
          controller.close();
        },
      }),
      contentType: "application/octet-stream",
      sizeBytes: segment.bytes.byteLength,
    });
    mocks.storage.mockReturnValue({ driver: "fake", get: mocks.objectGet });
    const dialect = new PgDialect();
    const execute = vi.fn((query: SQL) => {
      // The compacted-seals query is the one that names seals with no hot
      // rows left; the hot read answers nothing.
      if (dialect.sqlToQuery(query).sql.includes("NOT EXISTS")) {
        return Promise.resolve([
          {
            attempt_id: UUID_ATTEMPT,
            attempt_public_id: "arat_0123456789abcdefghjkmn",
            archive_segment_ref: ref,
            final_run_seq: "2",
          },
        ]);
      }
      return Promise.resolve([]);
    });
    mocks.withTenantDb.mockImplementation(makeWithTenantDbMock({ execute }));

    // The store is built before the storage driver is opened.
    const deps = defaultRunReadDeps();
    expect(mocks.storage).not.toHaveBeenCalled();

    const frames = await readFrames(deps, run, "0", 10);
    expect(mocks.objectGet).toHaveBeenCalledWith(ref);
    expect(frames.map((f) => [f.seq, f.type, f.digest])).toEqual([
      ["1", "tool.call_completed", SHA_1],
      ["2", "tool.call_completed", SHA_2],
    ]);
  });
});

const ROOT = "0192d4a8-7c1e-7a00-8000-00000000c0de";
const CHILD = "0192d4a8-7c1e-7a00-8000-00000000c1d0";

/** A wrapped run whose session row says it holds `seqCount` seqs. */
const tachoRun = (seqCount: number) =>
  ({
    source: "tacho",
    sessionUuid: ROOT,
    row: { session: { seqCount } },
  }) as unknown as ResolvedRun;

type FrameArgs = { afterSeq: number; throughSeq?: number; limit: number };

/** A `tacho_events` read over the root chain's `seqs`, honouring the bound. */
function rootFrames(seqs: number[]) {
  return vi.fn((args: FrameArgs) =>
    Promise.resolve(
      seqs
        .filter(
          (seq) =>
            seq > args.afterSeq &&
            (args.throughSeq === undefined || seq <= args.throughSeq),
        )
        .slice(0, args.limit)
        .map((seq) => tachoRow(seq)),
    ),
  );
}

describe("readFrames: a wrapped run's own chain", () => {
  it("reads a window bounded at `afterSeq + limit`, in one query", async () => {
    const tachoFrames = rootFrames([0, 1, 2, 3, 4, 5]);
    const deps = { tachoFrames } as unknown as RunReadDeps;
    const frames = await readFrames(deps, tachoRun(6), "1", 3);
    expect(frames.map((f) => f.seq)).toEqual(["2", "3", "4"]);
    expect(tachoFrames.mock.calls).toEqual([
      [{ sessionUuid: ROOT, afterSeq: 1, throughSeq: 4, limit: 3 }],
    ]);
  });

  it("reads past the window when a chain break left a hole in it", async () => {
    // Seqs 3 and 4 were never recorded; the chain goes on to 7.
    const tachoFrames = rootFrames([0, 1, 2, 5, 6, 7]);
    const deps = { tachoFrames } as unknown as RunReadDeps;
    const frames = await readFrames(deps, tachoRun(8), "-1", 5);
    expect(frames.map((f) => f.seq)).toEqual(["0", "1", "2", "5", "6"]);
    expect(tachoFrames.mock.calls).toEqual([
      [{ sessionUuid: ROOT, afterSeq: -1, throughSeq: 4, limit: 5 }],
      [{ sessionUuid: ROOT, afterSeq: 4, limit: 2 }],
    ]);
  });

  it("makes no second read at the end of the chain (negative)", async () => {
    const tachoFrames = rootFrames([0, 1, 2]);
    const deps = { tachoFrames } as unknown as RunReadDeps;
    const frames = await readFrames(deps, tachoRun(3), "0", 10);
    expect(frames.map((f) => f.seq)).toEqual(["1", "2"]);
    expect(tachoFrames).toHaveBeenCalledTimes(1);
  });
});

describe("readFrameAt: a wrapped run", () => {
  it("bounds the read at the frame it wants", async () => {
    const tachoFrames = rootFrames([0, 1, 2]);
    const deps = { tachoFrames } as unknown as RunReadDeps;
    const frame = await readFrameAt(deps, tachoRun(3), "1");
    expect(frame?.seq).toBe("1");
    expect(tachoFrames.mock.calls).toEqual([
      [{ sessionUuid: ROOT, afterSeq: 0, throughSeq: 1, limit: 1 }],
    ]);
  });

  it("answers null for a seq a chain break skipped, without reading past it (negative)", async () => {
    const tachoFrames = rootFrames([0, 1, 5]);
    const deps = { tachoFrames } as unknown as RunReadDeps;
    expect(await readFrameAt(deps, tachoRun(6), "3")).toBeNull();
    expect(tachoFrames).toHaveBeenCalledTimes(1);
  });
});

// The composition itself (the splice, the cap over every chain, the listed
// chains) is `readRunChains` and `subagentChainRead` in @oxagen/run-ledger,
// tested there. These check that `deps` reaches it: the root chain through
// `tachoFrames`, the subagents through `tachoSubagentFrames` and
// `tachoChildSessions`.
describe("runChainReads: a wrapped run's subagent chains", () => {
  const run = tachoRun(3);
  const readRunFrames = (d: RunReadDeps, r: ResolvedRun, cap: number) =>
    readRunChains(runChainReads(d, r), cap);
  const child = (seq: number) =>
    tachoRow(seq, {
      sessionUuid: CHILD,
      rootSessionUuid: ROOT,
      parentSessionUuid: ROOT,
    });

  function deps(childRows: ReturnType<typeof child>[]) {
    const subagents = vi.fn(
      (args: { after: { seq: number } | null; limit: number }) =>
        Promise.resolve(
          childRows
            .filter((r) => args.after === null || r.seq > args.after.seq)
            .slice(0, args.limit),
        ),
    );
    const tachoFrames = rootFrames([0, 1, 2]);
    return {
      subagents,
      tachoFrames,
      deps: {
        tachoFrames,
        tachoSubagentFrames: subagents,
      } as unknown as RunReadDeps,
    };
  }

  it("reads every chain under the root, and says when the cap cut the subagents short", async () => {
    const whole = await readRunFrames(deps([child(0), child(1)]).deps, run, 10);
    expect(whole.complete).toBe(true);
    // No spawn was recorded, so the chain goes where it began: after the
    // root frame it started with.
    expect(whole.frames.map((f) => f.chain?.sessionUuid ?? "root")).toEqual([
      "root",
      CHILD,
      CHILD,
      "root",
      "root",
    ]);
    const cut = deps([child(0), child(1), child(2)]);
    const capped = await readRunFrames(cut.deps, run, 4);
    expect(capped.frames).toHaveLength(4);
    expect(capped.complete).toBe(false);
  });

  it("reads each store once: the root chain bounded, the subagents in one read", async () => {
    const wired = deps([child(0), child(1)]);
    await readRunFrames(wired.deps, run, 10);
    expect(wired.tachoFrames.mock.calls).toEqual([
      [{ sessionUuid: ROOT, afterSeq: -1, throughSeq: 10, limit: 11 }],
    ]);
    expect(wired.subagents.mock.calls).toEqual([
      [{ rootSessionUuid: ROOT, after: null, limit: 11 }],
    ]);
  });

  it("names the listed chains to ClickHouse, so it reads only their ranges", async () => {
    const wired = deps([child(0), child(1)]);
    const listed = vi.fn(() => Promise.resolve([CHILD]));
    const read = await readRunFrames(
      { ...wired.deps, tachoChildSessions: listed },
      run,
      10,
    );
    expect(read.frames).toHaveLength(5);
    expect(listed).toHaveBeenCalledWith(ROOT);
    expect(wired.subagents.mock.calls).toEqual([
      [
        {
          rootSessionUuid: ROOT,
          after: null,
          limit: 11,
          sessionUuids: [CHILD],
        },
      ],
    ]);
  });

  it("makes no subagent read when Postgres lists no chains (negative)", async () => {
    const wired = deps([child(0)]);
    const read = await readRunFrames(
      { ...wired.deps, tachoChildSessions: () => Promise.resolve([]) },
      run,
      10,
    );
    expect(read).toMatchObject({ complete: true });
    expect(read.frames).toHaveLength(3);
    expect(wired.subagents).not.toHaveBeenCalled();
  });

  it("reads only the run's own chain when no subagent reader is wired (negative)", async () => {
    const { deps: wired } = deps([child(0)]);
    const own = await readRunFrames(
      { ...wired, tachoSubagentFrames: undefined },
      run,
      10,
    );
    expect(own.frames).toHaveLength(3);
  });

  it("reads no subagent chains for a ledger run, which records none (negative)", () => {
    const { deps: wired } = deps([child(0)]);
    const ledger: ResolvedRun = {
      source: "ledger",
      runId: UUID_RUN,
      row: {} as never,
      record: {} as never,
      item: {} as never,
      witnessFor: null,
    };
    expect(runChainReads(wired, ledger).subagents).toBeNull();
  });
});
