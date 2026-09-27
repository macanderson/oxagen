/**
 * A compacted attempt read back from its archive segment (spec §13.3,
 * #4000). Compaction deletes an attempt's hot frames, and every reader then
 * restores them from the segment the seal wrote (`framesFromSegment`). These
 * tests hold the restored frames to the seal's own figures:
 *
 *   - each frame recomputes the `event_digest` it carries, from its payload;
 *   - the restored digests fold to the seal's `event_stream_digest` and root
 *     to its Merkle root;
 *   - the segment's bytes hash to the digest the seal stored; and
 *   - the attestation the seal signed verifies over the figures a reader
 *     recomputes from the segment alone (ADR-195).
 *
 * A segment changed after the seal fails the last check, which is what makes
 * a compacted run as verifiable as a hot one.
 */
import { generateKeyPairSync } from "node:crypto";
import {
  type Attestation,
  attesterKeyFromPem,
  buildArchiveSegment,
  digestBytes,
  merkleRoot,
  verifyAttestation,
} from "@oxagen/tacho";
import { describe, expect, it } from "vitest";
import {
  type SealAttestationFigures,
  sealAttestationPayload,
  signSealAttestation,
} from "./attester";
import {
  computeEventDigest,
  computeEventStreamDigest,
  validateInlineEventPayload,
} from "./event-payload-registry";
import { archiveFrameOf } from "./frame-body";
import {
  type AttemptEventReadRecord,
  type AttemptEventStateRow,
  type CompactedSealRow,
  framesFromSegment,
  type PreparedAttemptEvent,
  prepareAttemptEvent,
} from "./run-store";

const SHA = `sha256:${"1".repeat(64)}`;
const RUN_PUBLIC_ID = "arun_0123456789abcdefghjkmn";
const ATTEMPT_ID = "44444444-4444-4444-8444-444444444444";
const ATTEMPT_PUBLIC_ID = "arat_0123456789abcdefghjkmn";

const key = attesterKeyFromPem(
  generateKeyPairSync("ed25519")
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString(),
);

/** A tool call, a model call and the terminal event, as a producer sends them. */
function prepared(): PreparedAttemptEvent[] {
  return [
    prepareAttemptEvent({
      attemptSeq: 1,
      eventType: "tool.call_completed",
      observedAt: "2026-09-14T12:00:01.000Z",
      payload: {
        tool_call_id: "call_1",
        capability_name: "edit_repo_file",
        outcome: "completed",
        input_digest: SHA,
        authorization_decision_ref: "azd_0123456789abcdef0123",
        duration_ms: 5,
      },
    }),
    prepareAttemptEvent({
      attemptSeq: 2,
      eventType: "model.call_completed",
      // Any RFC 3339 form: the digest is taken over the instant's ISO form.
      observedAt: "2026-09-14T14:00:02.250+02:00",
      payload: {
        model_call_id: "mc_2",
        turn_index: 0,
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        model_policy_decision_ref: "azd_0123456789abcdef",
        model_config_digest: SHA,
        system_instruction_digest: SHA,
        message_sequence_digest: SHA,
        tool_schema_digest: SHA,
        ordered_frame_use_digest: SHA,
        outcome: "completed",
      },
    }),
    prepareAttemptEvent({
      attemptSeq: 3,
      eventType: "terminal.attempt_terminated",
      observedAt: "2026-09-14T12:00:03.000Z",
      payload: { terminal_status: "completed" },
    }),
  ];
}

/**
 * The durable rows the seal read, as the driver answers them. The last row's
 * instants come back as Postgres text, the way drizzle's postgres-js driver
 * returns `timestamptz`.
 */
function durableRows(events: readonly PreparedAttemptEvent[]) {
  return events.map(
    (event, i): AttemptEventStateRow => ({
      id: `event-${i + 1}`,
      attempt_seq: event.attemptSeq,
      run_seq: String(i + 5),
      event_schema_version: event.eventSchemaVersion,
      event_type: event.eventType,
      stage: event.stage,
      payload_digest: event.payloadDigest,
      event_digest: event.eventDigest,
      payload_inline: event.payload,
      encrypted_payload_ref: event.encryptedPayloadRef,
      observed_at:
        i === events.length - 1
          ? event.observedAt.replace("T", " ").replace("Z", "+00")
          : event.observedAt,
      created_at: "2026-09-14T12:00:04.000Z",
      body_ref: null,
      body_digest: null,
      body_bytes: null,
      redactions: null,
      fidelity: "digest_only",
    }),
  );
}

/** What the seal wrote: the segment, and the figures on the seal row. */
function sealOf(rows: readonly AttemptEventStateRow[]) {
  const segment = buildArchiveSegment(rows.map(archiveFrameOf));
  const events = prepared();
  const figures: SealAttestationFigures = {
    runPublicId: RUN_PUBLIC_ID,
    attemptPublicId: ATTEMPT_PUBLIC_ID,
    frameCount: segment.frameCount,
    merkleRoot: segment.merkleRoot,
    archiveSegmentDigest: segment.segmentDigest,
    enforcementTier: "harness",
    completenessGaps: ["body_missing", "tool_bodies"],
    replayGrade: "inspect",
  };
  const columns = signSealAttestation(key, figures);
  return {
    segment,
    figures,
    columns,
    eventDigests: rows.map((row) => row.event_digest),
    eventStreamDigest: computeEventStreamDigest(
      events.map((event) => ({
        attemptSeq: event.attemptSeq,
        eventSchemaVersion: event.eventSchemaVersion,
        eventType: event.eventType,
        payloadDigest: event.payloadDigest,
      })),
    ),
    compacted: {
      attempt_id: ATTEMPT_ID,
      attempt_public_id: ATTEMPT_PUBLIC_ID,
      archive_segment_ref: `evidence/segment/${segment.segmentDigest.slice(7)}`,
      final_run_seq: rows.at(-1)?.run_seq.toString() ?? "0",
    } satisfies CompactedSealRow,
  };
}

/** The figures a reader recomputes from the stored bytes, with nothing else. */
function figuresFromSegment(
  bytes: Uint8Array,
  restored: readonly AttemptEventReadRecord[],
  sealed: SealAttestationFigures,
): SealAttestationFigures {
  return {
    ...sealed,
    frameCount: restored.length,
    merkleRoot: merkleRoot(
      restored.map((frame) => frame.eventDigest as `sha256:${string}`),
    ),
    archiveSegmentDigest: digestBytes(bytes),
  };
}

function attestationOf(
  figures: SealAttestationFigures,
  sig: string | null,
): Attestation {
  if (sig === null) throw new Error("the seal was signed");
  return {
    payload: sealAttestationPayload(figures),
    key_id: key.keyId,
    alg: "ed25519",
    sig,
  };
}

describe("a compacted attempt read from its archive segment", () => {
  const rows = durableRows(prepared());
  const seal = sealOf(rows);
  const restored = framesFromSegment(
    seal.compacted,
    seal.segment.bytes,
    "0",
  );

  it("restores every frame the seal committed to, in order", () => {
    expect(restored.map((frame) => frame.runSeq)).toEqual(["5", "6", "7"]);
    expect(restored.map((frame) => frame.eventDigest)).toEqual(
      seal.eventDigests,
    );
    for (const frame of restored) {
      expect(frame.attemptId).toBe(ATTEMPT_ID);
      expect(frame.attemptPublicId).toBe(ATTEMPT_PUBLIC_ID);
    }
  });

  it("recomputes each frame's payload digest and event digest from what the segment holds", () => {
    for (const frame of restored) {
      const { payloadDigest } = validateInlineEventPayload(
        frame.eventType,
        frame.payload,
      );
      expect(payloadDigest).toBe(frame.payloadDigest);
      expect(
        computeEventDigest({
          attemptSeq: frame.attemptSeq,
          eventSchemaVersion: frame.eventSchemaVersion,
          eventType: frame.eventType,
          stage: frame.stage,
          payloadDigest,
          observedAt: frame.observedAt.toISOString(),
        }),
      ).toBe(frame.eventDigest);
    }
  });

  it("folds to the seal's event stream digest and roots to its Merkle root", () => {
    expect(
      computeEventStreamDigest(
        restored.map((frame) => ({
          attemptSeq: frame.attemptSeq,
          eventSchemaVersion: frame.eventSchemaVersion,
          eventType: frame.eventType,
          payloadDigest: frame.payloadDigest,
        })),
      ),
    ).toBe(seal.eventStreamDigest);
    expect(
      merkleRoot(
        restored.map((frame) => frame.eventDigest as `sha256:${string}`),
      ),
    ).toBe(seal.figures.merkleRoot);
  });

  it("hashes to the segment digest the seal stored", () => {
    expect(digestBytes(seal.segment.bytes)).toBe(
      seal.columns.archiveSegmentDigest,
    );
  });

  it("verifies the attestation the seal signed, over figures recomputed from the segment alone", () => {
    const figures = figuresFromSegment(
      seal.segment.bytes,
      restored,
      seal.figures,
    );
    expect(seal.columns.attestationKeyId).toBe(key.keyId);
    expect(
      verifyAttestation(
        attestationOf(figures, seal.columns.attestationSig),
        key.publicKeyPem,
      ),
    ).toBe(true);
  });

  it("fails the attestation when the segment changed after the seal (negative)", () => {
    // Rewrite what frame 2 said and keep every digest it carried: a segment
    // written in place of the one the seal named.
    const edited = rows.map((row, i) =>
      i === 1
        ? {
            ...row,
            payload_inline: {
              ...(row.payload_inline as Record<string, unknown>),
              model: "claude-haiku-4-5",
            },
          }
        : row,
    );
    const swapped = buildArchiveSegment(edited.map(archiveFrameOf)).bytes;
    const back = framesFromSegment(seal.compacted, swapped, "0");
    // The digests the frame carries still fold and root: only a recomputed
    // payload digest, or the segment digest the seal signed, can tell.
    expect(
      validateInlineEventPayload(back[1]?.eventType ?? "", back[1]?.payload)
        .payloadDigest,
    ).not.toBe(back[1]?.payloadDigest);
    expect(
      verifyAttestation(
        attestationOf(
          figuresFromSegment(swapped, back, seal.figures),
          seal.columns.attestationSig,
        ),
        key.publicKeyPem,
      ),
    ).toBe(false);
  });

  it("fails the attestation when a frame was dropped from the segment (negative)", () => {
    const shorter = buildArchiveSegment(
      rows.slice(0, 2).map(archiveFrameOf),
    ).bytes;
    const back = framesFromSegment(seal.compacted, shorter, "0");
    expect(back).toHaveLength(2);
    expect(
      verifyAttestation(
        attestationOf(
          figuresFromSegment(shorter, back, seal.figures),
          seal.columns.attestationSig,
        ),
        key.publicKeyPem,
      ),
    ).toBe(false);
  });
});
