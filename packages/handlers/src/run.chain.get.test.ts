import { isHandlerError } from "@oxagen/oxagen/handler-error";
import { runChainGet } from "@oxagen/oxagen/contracts/run.chain.get";
import type { TachoFrameRow } from "@oxagen/telemetry";
import { describe, expect, it } from "vitest";
import {
  type CheckpointRow,
  createRunChainGetHandler,
  missingBodies,
  type RunChainGetDeps,
  sequenceGaps,
} from "./run.chain.get";
import {
  ctx,
  ledgerRun,
  memoryEvents,
  memoryStores,
  memoryTachoFrames,
  seal,
  summary,
  tachoRow,
  tachoSession,
} from "./run.test-support";

const TACHO_ID = "tse_4q8r1t6v3x5z0b2d7h2k9m";
const SESSION_UUID = "0192d4a8-7c1e-7a00-8000-00000000c0de";
const LEDGER_ID = "arun_0123456789abcdefghjkmn";
const RUN_UUID = "0192d4a8-7c1e-7a00-8000-0000000000a1";
const HEAD = `sha256:${"a".repeat(64)}`;

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
    checkpoints: () => Promise.resolve(over.checkpoints ?? []),
    ledgerSeals: () =>
      Promise.reject(new Error("a wrapped session reads no ledger seals")),
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
) {
  const stores = memoryStores(
    [
      ledgerRun({
        publicId: LEDGER_ID,
        runId: RUN_UUID,
        seal: attemptSeals.at(-1) ?? seal(RUN_UUID, sealOver),
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
    expect(out.merkleRoot).toBe(wholeSessionHash);
    expect(out.seals).toEqual([
      expect.objectContaining({
        finalEventDigest: wholeSessionHash,
        eventStreamDigest: wholeSessionHash,
        merkleRoot: wholeSessionHash,
      }),
    ]);
  });

  it("answers a wrapped session's hash rule, checkpoints and root, and the grade ladder", async () => {
    const chain = tachoHarness([tachoRow(0), tachoRow(1), tachoRow(2)], {
      checkpoints: [checkpoint({ seq: 2, eventCount: 3 })],
      session: { replayGrade: "inspect", enforcementTier: "observe" },
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
