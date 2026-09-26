import { describe, expect, it } from "vitest";
import {
  chainCheckpointSchema,
  chainGapsSchema,
  replayGradeRungSchema,
  runChainGet,
} from "./run.chain.get";

const RUN = "tse_0a1b2c3d4e";

const output = {
  runId: RUN,
  hashRule: "tacho.sha256_prev_hash_v1",
  frameCount: 3,
  firstSeq: "0",
  lastSeq: "2",
  merkleRoot: `sha256:${"a".repeat(64)}`,
  checkpoints: [],
  gaps: {
    missingSequences: [],
    missingFrameCount: 0,
    missingBodies: 0,
    recorded: [],
  },
  seals: [],
  enforcementTier: "observe",
  recordedGrade: null,
  ladder: [
    { grade: "inspect", met: true, reason: "frames_recorded" },
    { grade: "view", met: false, reason: "observe_tier" },
    { grade: "fork", met: false, reason: "observe_tier" },
    { grade: "retry", met: false, reason: "observe_tier" },
  ],
  complete: true,
};

describe("get_run_chain contract", () => {
  it("is a console read: mutates false, noBillingGate true", () => {
    expect(runChainGet.mutates).toBe(false);
    expect(runChainGet.noBillingGate).toBe(true);
    expect(runChainGet.scoped).toBe(true);
    expect(runChainGet.defaultEffect).toBe("deny");
  });

  it("declares the cli surface and layer that `oxagen run chain` ships", () => {
    expect(runChainGet.surfaces).toEqual(["api", "mcp", "cli"]);
    expect(runChainGet.layers).toContain("cli");
  });

  it("takes a run id of either store and nothing else (negative)", () => {
    expect(runChainGet.input.safeParse({ runId: RUN }).success).toBe(true);
    expect(runChainGet.input.safeParse({ runId: "arun_0a1b2c" }).success).toBe(
      true,
    );
    expect(runChainGet.input.safeParse({ runId: "nope" }).success).toBe(false);
    expect(runChainGet.input.safeParse({ runId: RUN, limit: 10 }).success).toBe(
      false,
    );
  });

  it("names the hash rule from a closed set, so a verifier recomputes with it (negative)", () => {
    expect(runChainGet.output.safeParse(output).success).toBe(true);
    expect(
      runChainGet.output.safeParse({ ...output, hashRule: "sha1" }).success,
    ).toBe(false);
  });

  it("answers null for a root and no seals for a run that has not recorded one, never a zero", () => {
    const unsealed = runChainGet.output.safeParse({
      ...output,
      merkleRoot: null,
      seals: [],
      recordedGrade: null,
      firstSeq: null,
      lastSeq: null,
      frameCount: 0,
    });
    expect(unsealed.success).toBe(true);
  });

  it("carries one seal per attempt, oldest first, not only the latest (finding 8, negative)", () => {
    const seal = {
      sealedAt: "2026-09-11T10:05:00.000Z",
      terminalStatus: "completed",
      eventCount: 3,
      finalRunSeq: "3",
      finalEventDigest: `sha256:${"d".repeat(64)}`,
      eventStreamDigest: `sha256:${"e".repeat(64)}`,
      merkleRoot: `sha256:${"f".repeat(64)}`,
      archiveSegmentRef: null,
      archiveSegmentDigest: null,
      attestation: null,
    };
    const retried = runChainGet.output.safeParse({
      ...output,
      seals: [{ ...seal, terminalStatus: "abandoned" }, seal],
    });
    expect(retried.success).toBe(true);
    // `seal` (singular, nullable) is not the shape any more.
    expect(runChainGet.output.safeParse({ ...output, seal }).success).toBe(
      false,
    );
  });

  it("carries a seal's attestation with the fields it signs, and its segment digest (#4000)", () => {
    const seal = {
      sealedAt: "2026-09-11T10:05:00.000Z",
      terminalStatus: "completed",
      eventCount: 3,
      finalRunSeq: "3",
      finalEventDigest: `sha256:${"d".repeat(64)}`,
      eventStreamDigest: `sha256:${"e".repeat(64)}`,
      merkleRoot: `sha256:${"f".repeat(64)}`,
      archiveSegmentRef: "segments/arun_0a1b2c/1.ndjson.zst",
      archiveSegmentDigest: `sha256:${"c".repeat(64)}`,
      attestation: {
        alg: "ed25519",
        keyId: "ak:7f3a",
        sig: "c2lnbmF0dXJl",
        signsOver: [
          "run_id",
          "attempt_id",
          "frame_count",
          "merkle_root",
          "archive_segment_digest",
          "enforcement_tier",
          "completeness_gaps",
          "replay_grade",
        ],
      },
    };
    const ok = (s: Record<string, unknown>) =>
      runChainGet.output.safeParse({ ...output, seals: [s] }).success;
    expect(ok(seal)).toBe(true);
    // A digest that is not sha256, a field the payload does not carry, and an
    // attestation that signs nothing are refused (negative).
    expect(ok({ ...seal, archiveSegmentDigest: "md5:abc" })).toBe(false);
    expect(
      ok({
        ...seal,
        attestation: { ...seal.attestation, signsOver: ["run_id", "cost"] },
      }),
    ).toBe(false);
    expect(
      ok({ ...seal, attestation: { ...seal.attestation, signsOver: [] } }),
    ).toBe(false);
    expect(
      ok({ ...seal, attestation: { ...seal.attestation, alg: "rsa" } }),
    ).toBe(false);
    const { attestation: _unread, ...unattested } = seal;
    expect(ok(unattested)).toBe(false);
  });

  it("carries a signed checkpoint with its countersignature and anchor, both nullable", () => {
    const checkpoint = {
      seq: "20",
      chainHead: `sha256:${"b".repeat(64)}`,
      eventCount: 20,
      signedAt: "2026-09-11T09:02:00.000Z",
      deviceKeyFingerprint: "dk:abc",
      platformKeyId: null,
      countersignedAt: null,
      anchorRoot: null,
      anchoredAt: null,
    };
    expect(chainCheckpointSchema.safeParse(checkpoint).success).toBe(true);
    expect(
      chainCheckpointSchema.safeParse({
        ...checkpoint,
        platformKeyId: "pk:1",
        countersignedAt: "2026-09-11T09:03:00.000Z",
      }).success,
    ).toBe(true);
    expect(
      chainCheckpointSchema.safeParse({ ...checkpoint, seq: "-1" }).success,
    ).toBe(false);
  });

  it("publishes gaps from the closed vocabulary only (negative)", () => {
    expect(
      chainGapsSchema.safeParse({
        missingSequences: [{ from: "1", to: "4" }],
        missingFrameCount: 4,
        missingBodies: 2,
        recorded: ["chain_break", "tool_bodies"],
      }).success,
    ).toBe(true);
    expect(
      chainGapsSchema.safeParse({
        ...output.gaps,
        recorded: ["something_new"],
      }).success,
    ).toBe(false);
    expect(
      chainGapsSchema.safeParse({ ...output.gaps, missingBodies: -1 }).success,
    ).toBe(false);
  });

  it("carries a reason on every rung, met or not", () => {
    expect(
      replayGradeRungSchema.safeParse({
        grade: "fork",
        met: false,
        reason: "enforcement_tier:harness",
      }).success,
    ).toBe(true);
    expect(
      replayGradeRungSchema.safeParse({ grade: "fork", met: false }).success,
    ).toBe(false);
    expect(
      replayGradeRungSchema.safeParse({
        grade: "replay",
        met: true,
        reason: "x",
      }).success,
    ).toBe(false);
  });
});
