import { schema } from "@oxagen/database";
import { isHandlerError } from "@oxagen/oxagen/handler-error";
import { runChainGet } from "@oxagen/oxagen/contracts/run.chain.get";
import type { TachoFrameRow } from "@oxagen/telemetry";
import { drizzle } from "drizzle-orm/pg-proxy";
import { describe, expect, it } from "vitest";
import {
  type ChainCheckpointRow,
  type CheckpointRow,
  createRunChainGetHandler,
  missingBodies,
  type RunChainGetDeps,
  framesMayHaveExpired,
  sequenceGaps,
  tachoChainCheckpointsQuery,
} from "./run.chain.get";
import {
  ctx,
  ledgerRun,
  memoryEvents,
  memoryStores,
  memorySubagentChains,
  memorySubagentFrames,
  memoryTachoFrames,
  SCOPE,
  seal,
  subagentChain,
  type SubagentChainFixture,
  summary,
  tachoRow,
  tachoSession,
} from "./run.test-support";

const TACHO_ID = "tse_4q8r1t6v3x5z0b2d7h2k9m";
const SESSION_UUID = "0192d4a8-7c1e-7a00-8000-00000000c0de";
/** Default `tacho.sessions.id` from `tachoSession()` in run.test-support. */
const SESSION_ROW_ID = "0192d4a8-7c1e-7000-8000-00000000c0de";
const LEDGER_ID = "arun_0123456789abcdefghjkmn";
const RUN_UUID = "0192d4a8-7c1e-7a00-8000-0000000000a1";
const HEAD = `sha256:${"a".repeat(64)}`;
/**
 * The clock every harness reads, two weeks after the fixture sessions start,
 * so no case depends on the day it runs.
 */
const NOW = new Date("2026-09-25T12:00:00.000Z");

function checkpoint(over: Partial<CheckpointRow> = {}): CheckpointRow {
  return {
    seq: 20,
    chainHead: HEAD,
    eventCount: 20,
    signedAt: new Date("2026-09-11T09:02:00.000Z"),
    deviceKeyFingerprint: "dk:abc",
    platformKeyId: null,
    countersignedAt: null,
    anchorRoot: null,
    anchoredAt: null,
    ...over,
  };
}

function tachoHarness(
  rows: TachoFrameRow[],
  over: {
    checkpoints?: CheckpointRow[];
    session?: Record<string, unknown>;
    onCheckpoints?: (sessionId: string) => void;
    now?: Date;
    /** The run's subagent chains, as Postgres lists them (#3823). */
    chains?: SubagentChainFixture[];
    /** Their frames, as the subagent read answers them. */
    children?: TachoFrameRow[];
    chainCheckpoints?: ChainCheckpointRow[];
  } = {},
) {
  // seqCount is the next expected sequence (last.seq + 1). Default it to the
  // fixture's span so boundary checks do not invent missing tails the test
  // never asked for; a test that wants a truncated ClickHouse walk overrides.
  const defaultSeqCount =
    rows.length === 0 ? 0 : Math.max(...rows.map((row) => row.seq)) + 1;
  const stores = memoryStores(
    [],
    [
      tachoSession({
        publicId: TACHO_ID,
        session: { seqCount: defaultSeqCount, ...over.session },
      }),
    ],
  );
  const deps: RunChainGetDeps = {
    queries: stores.queries,
    store: {
      getRunByPublicId: () => Promise.resolve(null),
      readAttemptEventsSince: memoryEvents([]),
    },
    readRunRollups: stores.readRunRollups,
    readWitnessFor: stores.readWitnessFor,
    tachoFrames: memoryTachoFrames(SESSION_UUID, rows),
    checkpoints: (_scope, sessionId) => {
      over.onCheckpoints?.(sessionId);
      return Promise.resolve(over.checkpoints ?? []);
    },
    chainCheckpoints: (_scope, sessionIds) =>
      Promise.resolve(
        (over.chainCheckpoints ?? []).filter((row) =>
          sessionIds.includes(row.sessionId),
        ),
      ),
    ...(over.chains === undefined
      ? {}
      : {
          tachoChains: memorySubagentChains(over.chains),
          tachoSubagentFrames: memorySubagentFrames(over.children ?? []),
        }),
    ledgerSeals: () =>
      Promise.reject(new Error("a wrapped session reads no ledger seals")),
    now: () => over.now ?? NOW,
  };
  return createRunChainGetHandler(deps);
}

/**
 * `attemptSeals`, oldest first, stands in for `ledgerAllSealsQuery`: every
 * attempt seal the run carries, not only the latest (finding 8,
 * macanderson/oxagen#3370). Defaults to one attempt built from `sealOver`, the
 * same single-seal shape the harness offered before that fix.
 */
function ledgerHarness(
  sealOver: Record<string, unknown> = {},
  attemptSeals = [seal(RUN_UUID, sealOver)],
  runOver: { status?: string } = {},
) {
  const stores = memoryStores(
    [
      ledgerRun({
        publicId: LEDGER_ID,
        runId: RUN_UUID,
        seal: attemptSeals.at(-1) ?? seal(RUN_UUID, sealOver),
        run: {
          runId: RUN_UUID,
          publicId: LEDGER_ID,
          status: runOver.status ?? "completed",
          createdAt: new Date("2026-09-11T10:00:00.000Z"),
          startedAt: new Date("2026-09-11T10:00:01.000Z"),
          name: null,
          summary: null,
          summaryGeneratedAt: null,
          summaryModel: null,
        },
      }),
    ],
    [],
  );
  const deps: RunChainGetDeps = {
    queries: stores.queries,
    store: {
      getRunByPublicId: (id) =>
        Promise.resolve(
          id === LEDGER_ID
            ? summary({ runId: RUN_UUID, publicId: LEDGER_ID })
            : null,
        ),
      readAttemptEventsSince: memoryEvents([]),
    },
    readRunRollups: stores.readRunRollups,
    readWitnessFor: stores.readWitnessFor,
    tachoFrames: memoryTachoFrames(SESSION_UUID, []),
    checkpoints: () => Promise.reject(new Error("a ledger run reads none")),
    chainCheckpoints: () =>
      Promise.reject(new Error("a ledger run has no subagent chains")),
    ledgerSeals: () => Promise.resolve(attemptSeals),
  };
  return createRunChainGetHandler(deps);
}

describe("sequenceGaps", () => {
  it("reports only the interior without bounds: a recording that starts at 7 is not missing 1 to 6", () => {
    const frames = [
      { seq: "7" },
      { seq: "8" },
      { seq: "12" },
      { seq: "13" },
    ] as never[];
    expect(sequenceGaps(frames)).toEqual({
      gaps: [{ from: "9", to: "11" }],
      missing: 3,
    });
  });

  it("answers no gaps for a dense chain and for one frame", () => {
    expect(sequenceGaps([{ seq: "1" }, { seq: "2" }] as never[]).gaps).toEqual(
      [],
    );
    expect(sequenceGaps([] as never[])).toEqual({ gaps: [], missing: 0 });
  });

  it("reports missing head and tail against recorded bounds (negative)", () => {
    // ClickHouse lost seq 0 and seq 4 of a wrapped session with seqCount 5.
    const frames = [{ seq: "1" }, { seq: "2" }, { seq: "3" }] as never[];
    expect(sequenceGaps(frames, { start: "0", end: "4" })).toEqual({
      gaps: [
        { from: "0", to: "0" },
        { from: "4", to: "4" },
      ],
      missing: 2,
    });
  });
});

describe("missingBodies", () => {
  it("counts a content-bearing frame with no retained body, and a recorded digest with no bytes", () => {
    const frames = [
      // A tool call with its body: not missing.
      { type: "tool_call", body: { bodyRef: "evb:1", bodyDigest: "sha256:a" } },
      // A tool call with no body at all: missing.
      { type: "tool_call", body: { bodyRef: null, bodyDigest: null } },
      // Not content-bearing, but its digest was recorded and its bytes were not.
      { type: "turn_start", body: { bodyRef: null, bodyDigest: "sha256:b" } },
      // Not content-bearing and carried nothing: not missing.
      { type: "turn_start", body: { bodyRef: null, bodyDigest: null } },
    ] as never[];
    expect(missingBodies(frames)).toBe(2);
  });

  it("does not count the OTel copy of a model call the proxy sealed with its body", () => {
    // The seal no longer counts that copy (`frameOwesBody`), so counting it
    // here showed a `body_missing` rung the recorded grade does not have.
    const frames = [
      {
        type: "llm_call",
        body: { bodyRef: "evb:1", bodyDigest: "sha256:a" },
        llmCall: { duplicateOf: null, keys: [], source: "collector" },
      },
      {
        type: "llm_call",
        body: { bodyRef: null, bodyDigest: null },
        llmCall: { duplicateOf: "collector", keys: [], source: "otel_log" },
      },
    ] as never[];
    expect(missingBodies(frames)).toBe(0);
    // A first sighting with no bytes is still missing its body.
    const otelOnly = [
      {
        type: "llm_call",
        body: { bodyRef: null, bodyDigest: null },
        llmCall: { duplicateOf: null, keys: [], source: "otel_log" },
      },
    ] as never[];
    expect(missingBodies(otelOnly)).toBe(1);
  });

  it("counts a model call whose body holds one half of the exchange", () => {
    // The seal leaves a half body out of `body_frames` and records
    // `body_missing`. Counting it retained showed that rung beside
    // "0 missing bodies".
    const frames = [
      {
        type: "llm_call",
        body: { bodyRef: "evb:1", bodyDigest: "sha256:a" },
        llmCall: {
          duplicateOf: null,
          keys: [],
          source: "collector",
          partial: true,
        },
      },
      {
        type: "llm_call",
        body: { bodyRef: "evb:2", bodyDigest: "sha256:b" },
        llmCall: {
          duplicateOf: null,
          keys: [],
          source: "collector",
          partial: false,
        },
      },
    ] as never[];
    expect(missingBodies(frames)).toBe(1);
  });
});

describe("get_run_chain", () => {
  it("uses the sealed session's final_hash, not a checkpoint that only covers a prefix (finding 1, negative)", async () => {
    // The collector stops checkpointing once `session.sealed` is written
    // (`terminalPatch`), so a checkpoint recorded well before the session
    // sealed covers only a prefix; `final_hash` is the commitment over the
    // whole session.
    const prefixHead = `sha256:${"b".repeat(64)}`;
    const wholeSessionHash = `sha256:${"c".repeat(64)}`;
    const chain = tachoHarness([tachoRow(0), tachoRow(1), tachoRow(2)], {
      checkpoints: [checkpoint({ seq: 1, chainHead: prefixHead })],
      session: { finalHash: wholeSessionHash },
    });
    const out = await chain({ runId: TACHO_ID }, ctx());
    // Top-level merkleRoot still surfaces the session commitment under
    // hashRule tacho.sha256_prev_hash_v1; the seal must not also rename that
    // chain head as a stream digest or Merkle root.
    expect(out.merkleRoot).toBe(wholeSessionHash);
    expect(out.seals).toEqual([
      expect.objectContaining({
        finalEventDigest: wholeSessionHash,
        eventStreamDigest: null,
        merkleRoot: null,
      }),
    ]);
  });

  it("answers a wrapped session's hash rule, checkpoints and root, and the grade ladder", async () => {
    let askedFor: string | null = null;
    const chain = tachoHarness([tachoRow(0), tachoRow(1), tachoRow(2)], {
      checkpoints: [checkpoint({ seq: 2, eventCount: 3 })],
      session: { replayGrade: "inspect", enforcementTier: "observe" },
      onCheckpoints: (sessionId) => {
        askedFor = sessionId;
      },
    });
    const out = await chain({ runId: TACHO_ID }, ctx());
    expect(runChainGet.output.parse(out)).toEqual(out);
    expect(out.hashRule).toBe("tacho.sha256_prev_hash_v1");
    expect(out.frameCount).toBe(3);
    expect(out.firstSeq).toBe("0");
    expect(out.lastSeq).toBe("2");
    expect(out.merkleRoot).toBe(HEAD);
    expect(out.checkpoints).toHaveLength(1);
    expect(out.checkpoints[0]).toMatchObject({ seq: "2", chainHead: HEAD });
    expect(out.enforcementTier).toBe("observe");
    expect(out.recordedGrade).toBe("inspect");
    expect(out.complete).toBe(true);
    // Checkpoints are keyed by the session row id, not the external UUID.
    expect(askedFor).toBe(SESSION_ROW_ID);
    // `seq_count` is last.seq + 1; the seal's final sequence is the last seq.
    // The fixture carries 3 rows (seq 0-2), so the harness's own default
    // seqCount (the fixture's span) is 3.
    expect(out.seals[0]).toMatchObject({
      eventCount: 3,
      finalRunSeq: "2",
    });
  });

  it("an observe-tier recording stops the ladder at inspect and says which rung refused", async () => {
    const chain = tachoHarness([tachoRow(0)], {
      session: { enforcementTier: "observe" },
    });
    const out = await chain({ runId: TACHO_ID }, ctx());
    expect(out.ladder.map((r) => [r.grade, r.met])).toEqual([
      ["inspect", true],
      ["view", false],
      ["fork", false],
      ["retry", false],
    ]);
    // The frame carried content and kept no body, so the read sees the gap
    // before it ever gets as far as the tier.
    expect(out.ladder[1]?.reason).toBe("body_missing");
  });

  it("a sequence gap the walk finds is a chain break in the ladder, even when the seal did not name it", async () => {
    const chain = tachoHarness([tachoRow(0), tachoRow(5)], {
      session: { completenessGaps: [] },
    });
    const out = await chain({ runId: TACHO_ID }, ctx());
    expect(out.gaps.missingSequences).toEqual([{ from: "1", to: "4" }]);
    expect(out.gaps.missingFrameCount).toBe(4);
    expect(out.gaps.recorded).toEqual([]);
    expect(out.ladder[1]).toMatchObject({ met: false });
    expect(out.ladder[1]?.reason).toContain("chain_break");
  });

  it("reports a missing head or tail against seqCount, not only interior gaps (negative)", async () => {
    // ClickHouse lost seq 0 and the last frame of a five-frame session.
    const chain = tachoHarness([tachoRow(1), tachoRow(2), tachoRow(3)], {
      session: { seqCount: 5, completenessGaps: [] },
    });
    const out = await chain({ runId: TACHO_ID }, ctx());
    expect(out.gaps.missingSequences).toEqual([
      { from: "0", to: "0" },
      { from: "4", to: "4" },
    ]);
    expect(out.gaps.missingFrameCount).toBe(2);
    expect(out.ladder[1]?.reason).toContain("chain_break");
  });

  // #4316: tacho_events keeps a frame 13 months after receipt (0032), and a
  // wrapped session has no archive, so an old session's first frames are gone.
  describe("frames past the tacho_events retention window", () => {
    /** A sealed session missing its first three frames, born at `createdAt`. */
    const expiredHead = (createdAt: Date, startedAt: Date = createdAt) =>
      tachoHarness([tachoRow(3), tachoRow(4)], {
        session: { seqCount: 5, completenessGaps: [], createdAt, startedAt },
      });

    it("reports no chain break and keeps the grade for a session older than the window", async () => {
      const out = await expiredHead(new Date("2025-08-01T00:00:00.000Z"))(
        { runId: TACHO_ID },
        ctx(),
      );
      expect(out.gaps.missingSequences).toEqual([]);
      expect(out.gaps.missingFrameCount).toBe(0);
      expect(out.ladder.some((r) => r.reason?.includes("chain_break"))).toBe(
        false,
      );
      // The same ladder as the session with every frame still held.
      const dense = await tachoHarness(
        [0, 1, 2, 3, 4].map((seq) => tachoRow(seq)),
        {
          session: { seqCount: 5, completenessGaps: [] },
        },
      )({ runId: TACHO_ID }, ctx());
      expect(out.ladder).toEqual(dense.ladder);
    });

    it("still reports the missing head of a session inside the window (negative)", async () => {
      const out = await expiredHead(new Date("2026-09-01T00:00:00.000Z"))(
        { runId: TACHO_ID },
        ctx(),
      );
      expect(out.gaps.missingSequences).toEqual([{ from: "0", to: "2" }]);
      expect(out.ladder[1]?.reason).toContain("chain_break");
    });

    // The TTL counts from the server's receipt. A host whose clock is set
    // back a year stamps an old `startedAt` on a fresh session, which used to
    // hide a real head break.
    it("still reports the missing head of a fresh session whose host clock is set back (negative)", async () => {
      const out = await expiredHead(
        new Date("2026-09-01T00:00:00.000Z"),
        new Date("2025-08-01T00:00:00.000Z"),
      )({ runId: TACHO_ID }, ctx());
      expect(out.gaps.missingSequences).toEqual([{ from: "0", to: "2" }]);
      expect(out.ladder[1]?.reason).toContain("chain_break");
    });

    it("still reports the missing head when the reader did not select the row's birth (negative)", async () => {
      const out = await tachoHarness([tachoRow(3), tachoRow(4)], {
        session: {
          seqCount: 5,
          completenessGaps: [],
          startedAt: new Date("2025-08-01T00:00:00.000Z"),
        },
      })({ runId: TACHO_ID }, ctx());
      expect(out.gaps.missingSequences).toEqual([{ from: "0", to: "2" }]);
    });

    it("still reports an interior gap in a session older than the window (negative)", async () => {
      const out = await tachoHarness([tachoRow(3), tachoRow(6)], {
        session: {
          seqCount: 7,
          completenessGaps: [],
          createdAt: new Date("2025-08-01T00:00:00.000Z"),
        },
      })({ runId: TACHO_ID }, ctx());
      expect(out.gaps.missingSequences).toEqual([{ from: "4", to: "5" }]);
      expect(out.ladder[1]?.reason).toContain("chain_break");
    });

    it("counts the window in calendar months from the row's birth, with no slack", () => {
      const now = new Date("2026-09-25T12:00:00.000Z");
      // 13 months before now is 2025-08-25T12:00Z.
      expect(
        framesMayHaveExpired(new Date("2025-08-25T11:59:00.000Z"), now),
      ).toBe(true);
      expect(
        framesMayHaveExpired(new Date("2025-08-25T12:00:00.000Z"), now),
      ).toBe(false);
      expect(
        framesMayHaveExpired(new Date("2025-08-31T12:00:00.000Z"), now),
      ).toBe(false);
      expect(
        framesMayHaveExpired(new Date("2026-09-11T10:00:01.000Z"), now),
      ).toBe(false);
    });
  });

  it("does not treat the unread capped tail as a chain break (finding 4052307524)", async () => {
    // The walk stops at CHAIN_FRAME_CAP while the seal still names a final
    // sequence past it. Those unread frames are not missing: complete: false
    // already says they were not read.
    const { CHAIN_FRAME_CAP } = await import(
      "@oxagen/oxagen/contracts/run.chain.get"
    );
    const rows = Array.from({ length: CHAIN_FRAME_CAP + 1 }, (_, i) =>
      tachoRow(i),
    );
    const chain = tachoHarness(rows, {
      session: {
        seqCount: CHAIN_FRAME_CAP + 50,
        completenessGaps: [],
      },
    });
    const out = await chain({ runId: TACHO_ID }, ctx());
    expect(out.complete).toBe(false);
    expect(out.frameCount).toBe(CHAIN_FRAME_CAP);
    expect(out.gaps.missingSequences).toEqual([]);
    expect(out.gaps.missingFrameCount).toBe(0);
    expect(out.ladder.some((r) => r.reason?.includes("chain_break"))).toBe(
      false,
    );
  });

  it("a wrapped seal's finalRunSeq is the last frame seq, not seqCount (negative)", async () => {
    const chain = tachoHarness([tachoRow(0), tachoRow(1), tachoRow(2)], {
      session: { seqCount: 3 },
    });
    const out = await chain({ runId: TACHO_ID }, ctx());
    expect(out.lastSeq).toBe("2");
    expect(out.seals[0]?.finalRunSeq).toBe("2");
    expect(out.seals[0]?.eventCount).toBe(3);
  });

  it("drops a gap word outside the closed vocabulary rather than passing it on", async () => {
    const chain = tachoHarness([tachoRow(0)], {
      session: { completenessGaps: ["tool_bodies", "something_new", 7] },
    });
    const out = await chain({ runId: TACHO_ID }, ctx());
    expect(out.gaps.recorded).toEqual(["tool_bodies"]);
  });

  it("a ledger run answers its seal, its root and no checkpoints", async () => {
    const chain = ledgerHarness({ enforcementTier: "gateway" });
    const out = await chain({ runId: LEDGER_ID }, ctx());
    expect(runChainGet.output.parse(out)).toEqual(out);
    expect(out.hashRule).toBe("ledger.event_stream_digest_v1");
    expect(out.checkpoints).toEqual([]);
    expect(out.enforcementTier).toBe("gateway");
    expect(out.seals).toHaveLength(1);
    // The ATTEMPT's terminal status and digests, not the run's word for them.
    expect(out.seals[0]).toMatchObject({
      terminalStatus: "completed",
      eventCount: 3,
      finalRunSeq: "3",
      finalEventDigest: `sha256:${"e".repeat(64)}`,
      eventStreamDigest: `sha256:${"d".repeat(64)}`,
      merkleRoot: `sha256:${"f".repeat(64)}`,
    });
    expect(out.merkleRoot).toBe(`sha256:${"f".repeat(64)}`);
    expect(out.recordedGrade).toBe("view");
  });

  it("clears recordedGrade while a retry is still live (negative)", async () => {
    // A sealed first attempt leaves its grade on `run.record.seal`; a live
    // retry must not present that historical grade as the current run's.
    const chain = ledgerHarness(
      { replayGrade: "view", enforcementTier: "gateway" },
      undefined,
      { status: "running" },
    );
    const out = await chain({ runId: LEDGER_ID }, ctx());
    expect(out.recordedGrade).toBeNull();
    expect(out.seals).toHaveLength(1);
  });

  it("a retried run answers one seal per attempt, not only the latest (finding 8, negative)", async () => {
    const firstAttempt = seal(RUN_UUID, {
      attemptId: "0192d4a8-7c1e-7a00-8000-0000000000b1",
      sealedAt: new Date("2026-09-11T10:01:00.000Z"),
      terminalStatus: "abandoned",
      merkleRoot: `sha256:${"1".repeat(64)}`,
    });
    const secondAttempt = seal(RUN_UUID, {
      attemptId: "0192d4a8-7c1e-7a00-8000-0000000000b2",
      sealedAt: new Date("2026-09-11T10:05:00.000Z"),
      terminalStatus: "completed",
      merkleRoot: `sha256:${"2".repeat(64)}`,
    });
    const chain = ledgerHarness({}, [firstAttempt, secondAttempt]);
    const out = await chain({ runId: LEDGER_ID }, ctx());
    expect(runChainGet.output.parse(out)).toEqual(out);
    // Both attempt seals are present, oldest first, each with its own root —
    // not the latest attempt's root presented beside a frame count and gap
    // analysis that (via `readAllFrames`) already span every attempt.
    expect(out.seals).toHaveLength(2);
    expect(out.seals[0]?.terminalStatus).toBe("abandoned");
    expect(out.seals[0]?.merkleRoot).toBe(`sha256:${"1".repeat(64)}`);
    expect(out.seals[1]?.terminalStatus).toBe("completed");
    expect(out.seals[1]?.merkleRoot).toBe(`sha256:${"2".repeat(64)}`);
    // The top-level summary field is the latest attempt's root.
    expect(out.merkleRoot).toBe(`sha256:${"2".repeat(64)}`);
  });

  it("a seal with no recorded tier reads as harness, which is what it was graded under", async () => {
    const chain = ledgerHarness({ enforcementTier: null });
    const out = await chain({ runId: LEDGER_ID }, ctx());
    expect(out.enforcementTier).toBe("harness");
    // Nothing above `inspect` is claimed for a recording this read cannot see
    // a body in; the recorded grade is still the seal's word.
    expect(out.ladder.filter((r) => r.met).map((r) => r.grade)).toEqual([
      "inspect",
    ]);
    expect(out.recordedGrade).toBe("view");
  });

  it("is not_found for a run outside the workspace (negative)", async () => {
    const chain = tachoHarness([]);
    await expect(chain({ runId: "tse_nope" }, ctx())).rejects.toSatisfy(
      (e) => isHandlerError(e) && e.code === "not_found",
    );
  });
});

// #3823: each subagent records on a hash chain of its own, numbered from 0,
// with its own session row and checkpoints. Its gaps are its own, never the
// run's, and the ladder still sees them.
describe("get_run_chain subagent chains (#3823)", () => {
  const CHILD = "0192d4a8-7c1e-7a00-8000-00000000c1d0";
  const SECOND = "0192d4a8-7c1e-7a00-8000-00000000c1d1";
  const THIRD = "0192d4a8-7c1e-7a00-8000-00000000c1d2";
  const EMPTY = "0192d4a8-7c1e-7a00-8000-00000000c1d3";
  const FOREIGN_ROOT = "0192d4a8-7c1e-7a00-8000-00000000beef";
  const FOREIGN_CHILD = "0192d4a8-7c1e-7a00-8000-00000000f0e1";
  const DIGEST = `sha256:${"c".repeat(64)}`;
  const SEALED_AT = new Date("2026-09-11T09:04:00.000Z");

  /** A frame that kept its body, so it owes nothing to the ladder. */
  const kept = (row: TachoFrameRow): TachoFrameRow => ({
    ...row,
    contentDigest: DIGEST,
    bytesRef: `evb:v1:k:${"c".repeat(64)}`,
  });
  const root = (seqs: number[]) => seqs.map((seq) => kept(tachoRow(seq)));
  /** A frame on a subagent chain, as the subagent read answers it. */
  const onChain = (session: string, seq: number, rootUuid = SESSION_UUID) =>
    tachoRow(seq, {
      sessionUuid: session,
      rootSessionUuid: rootUuid,
      parentSessionUuid: rootUuid,
      subagentId: "agent-1",
      subagentType: "Explore",
      spawnToolUseId: "toolu_A",
    });
  const chainRow = (
    sessionUuid: string,
    over: Partial<SubagentChainFixture> = {},
  ) => subagentChain({ sessionUuid, rootSessionUuid: SESSION_UUID, ...over });

  it("walks each subagent chain on its own, numbering its gaps on its own seq", async () => {
    const child = chainRow(CHILD, { seqCount: 4 });
    const second = chainRow(SECOND, {
      seqCount: 2,
      subagentId: "agent-2",
      subagentType: null,
      startedAt: new Date("2026-09-11T09:03:00.000Z"),
      finalHash: HEAD,
      sealedAt: SEALED_AT,
    });
    const foreign = subagentChain({
      sessionUuid: FOREIGN_CHILD,
      rootSessionUuid: FOREIGN_ROOT,
      seqCount: 1,
    });
    const chain = tachoHarness(root([0, 1, 2]), {
      session: { completenessGaps: [] },
      chains: [child, second, foreign],
      children: [
        // The child chain lost its seq 2.
        ...[0, 1, 3].map((seq) => kept(onChain(CHILD, seq))),
        ...[0, 1].map((seq) => kept(onChain(SECOND, seq))),
        kept(onChain(FOREIGN_CHILD, 0, FOREIGN_ROOT)),
      ],
      chainCheckpoints: [
        { ...checkpoint({ seq: 1, eventCount: 2 }), sessionId: child.sessionId },
        { ...checkpoint({ seq: 0 }), sessionId: foreign.sessionId },
      ],
    });
    const out = await chain({ runId: TACHO_ID }, ctx());
    expect(runChainGet.output.parse(out)).toEqual(out);
    // The run's own chain is whole: the child's gap is not the run's.
    expect(out.frameCount).toBe(3);
    expect(out.gaps.missingSequences).toEqual([]);
    expect(out.chains).toEqual([
      {
        sessionUuid: CHILD,
        parentSessionUuid: SESSION_UUID,
        subagentId: "agent-1",
        subagentType: "Explore",
        frameCount: 3,
        firstSeq: "0",
        lastSeq: "3",
        gaps: {
          missingSequences: [{ from: "2", to: "2" }],
          missingFrameCount: 1,
          missingBodies: 0,
        },
        checkpoints: [expect.objectContaining({ seq: "1", eventCount: 2 })],
        finalHash: null,
        sealedAt: null,
        complete: true,
      },
      {
        sessionUuid: SECOND,
        parentSessionUuid: SESSION_UUID,
        subagentId: "agent-2",
        subagentType: null,
        frameCount: 2,
        firstSeq: "0",
        lastSeq: "1",
        gaps: { missingSequences: [], missingFrameCount: 0, missingBodies: 0 },
        checkpoints: [],
        finalHash: HEAD,
        sealedAt: SEALED_AT.toISOString(),
        complete: true,
      },
    ]);
    // A break on a subagent's chain is a break in the run's record.
    expect(out.ladder[1]?.reason).toContain("chain_break");
    expect(out.complete).toBe(true);
  });

  it("carries a subagent's missing body to the ladder, and a whole subagent chain changes nothing (negative)", async () => {
    const alone = await tachoHarness(root([0, 1]), {
      session: { completenessGaps: [] },
      chains: [],
    })({ runId: TACHO_ID }, ctx());
    expect(alone.chains).toEqual([]);

    const whole = await tachoHarness(root([0, 1]), {
      session: { completenessGaps: [] },
      chains: [chainRow(CHILD, { seqCount: 1 })],
      children: [kept(onChain(CHILD, 0))],
    })({ runId: TACHO_ID }, ctx());
    expect(whole.ladder).toEqual(alone.ladder);

    const bodiless = await tachoHarness(root([0, 1]), {
      session: { completenessGaps: [] },
      chains: [chainRow(CHILD, { seqCount: 1 })],
      // A tool call that kept no body.
      children: [onChain(CHILD, 0)],
    })({ runId: TACHO_ID }, ctx());
    expect(bodiless.gaps.missingBodies).toBe(0);
    expect(bodiless.chains?.[0]?.gaps.missingBodies).toBe(1);
    expect(bodiless.ladder.some((r) => r.reason === "body_missing")).toBe(
      true,
    );
    expect(alone.ladder.some((r) => r.reason === "body_missing")).toBe(false);
  });

  it("marks the chain the frame cap cut, and every chain past it, incomplete", async () => {
    const spread = (session: string, count: number) =>
      Array.from({ length: count }, (_, seq) => kept(onChain(session, seq)));
    const chain = tachoHarness(root([0]), {
      session: { completenessGaps: [] },
      chains: [
        chainRow(CHILD, { seqCount: 6_000 }),
        chainRow(SECOND, { seqCount: 6_000 }),
        chainRow(THIRD, { seqCount: 10 }),
        // Registered, with nothing recorded: there was nothing to cut.
        chainRow(EMPTY, { seqCount: 0 }),
      ],
      children: [
        ...spread(CHILD, 6_000),
        ...spread(SECOND, 6_000),
        ...spread(THIRD, 10),
      ],
    });
    const out = await chain({ runId: TACHO_ID }, ctx());
    const byChain = new Map(out.chains?.map((c) => [c.sessionUuid, c]));
    expect(byChain.get(CHILD)).toMatchObject({
      frameCount: 6_000,
      complete: true,
    });
    // Cut short: no tail is reported missing for frames never read.
    expect(byChain.get(SECOND)).toMatchObject({
      frameCount: 4_000,
      lastSeq: "3999",
      complete: false,
      gaps: { missingSequences: [], missingFrameCount: 0 },
    });
    expect(byChain.get(THIRD)).toMatchObject({
      frameCount: 0,
      complete: false,
      gaps: { missingSequences: [], missingFrameCount: 0 },
    });
    expect(byChain.get(EMPTY)).toMatchObject({ frameCount: 0, complete: true });
    // The run's own chain was read whole, and the run's was not.
    expect(out.frameCount).toBe(1);
    expect(out.complete).toBe(false);
  });

  it("does not report the head of a subagent chain whose frames may have expired", async () => {
    const out = await tachoHarness(root([0]), {
      session: { completenessGaps: [] },
      chains: [
        chainRow(CHILD, {
          seqCount: 5,
          createdAt: new Date("2025-08-01T00:00:00.000Z"),
        }),
        chainRow(SECOND, { seqCount: 5 }),
      ],
      children: [
        ...[3, 4].map((seq) => kept(onChain(CHILD, seq))),
        ...[3, 4].map((seq) => kept(onChain(SECOND, seq))),
      ],
    })({ runId: TACHO_ID }, ctx());
    expect(out.chains?.[0]?.gaps.missingSequences).toEqual([]);
    // A chain inside the window still reports its lost head.
    expect(out.chains?.[1]?.gaps.missingSequences).toEqual([
      { from: "0", to: "2" },
    ]);
  });

  it("answers no chains on a ledger run (negative)", async () => {
    const out = await ledgerHarness()({ runId: LEDGER_ID }, ctx());
    expect("chains" in out).toBe(false);
  });

  it("reads the chains' checkpoints by their session row ids in one fenced query", () => {
    const db = drizzle(() => Promise.resolve({ rows: [] }), { schema });
    const ids = [
      "0192d4a8-7c1e-7000-8000-00000000c1d0",
      "0192d4a8-7c1e-7000-8000-00000000c1d1",
    ];
    const query = tachoChainCheckpointsQuery(db, SCOPE, ids).toSQL();
    expect(query.sql).toMatch(/"checkpoints"\."org_id" = \$\d+/);
    expect(query.sql).toMatch(/"checkpoints"\."workspace_id" = \$\d+/);
    expect(query.sql).toMatch(
      /"checkpoints"\."session_id" in \(\$\d+, \$\d+\)/,
    );
    expect(query.sql).toMatch(
      /order by "checkpoints"\."session_id" asc, "checkpoints"\."seq" asc/,
    );
    expect(query.params).toEqual([SCOPE.orgId, SCOPE.workspaceId, ...ids]);
  });
});
