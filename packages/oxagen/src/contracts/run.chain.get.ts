/**
 * `get_run_chain`: what makes one run's record tamper-evident, and what it is
 * missing (Mission Control spec §8.3, §8.4; the Run page's Chain-and-seal tab).
 *
 * It answers the rule the chain was built under, the Merkle root the seal
 * committed to, the signed checkpoints along the way, the gaps the read can
 * see, the seal itself, and the replay-grade ladder with the reason each rung
 * is or is not reached.
 *
 * ## Why this is its own capability and not more of `get_run`
 *
 * `get_run` is the per-render read and the long-poll target: an open run calls
 * it every `waitMs`, forever, and every field it carries is paid for on each
 * of those calls. The chain is the opposite shape — it is read once, when a
 * person opens the tab, and after the seal it never changes again. Folding it
 * into `get_run` would make every poll of every live run walk the frames for
 * missing sequences and missing bodies and read the checkpoint table, to
 * answer a question nobody asked on that render.
 *
 * They also differ in what they may refuse. `get_run` must answer for any run
 * a workspace holds; the chain read walks the recording, so it is bounded and
 * says so (`complete: false`) rather than silently reporting the gaps of a
 * prefix as the gaps of the run. A field that can honestly answer "I did not
 * look at all of it" does not belong on the read a page header depends on.
 *
 * No new store: the ledger's seal rows, the wrapped session's checkpoints and
 * the frames already recorded are all it reads.
 *
 * `noBillingGate: true`: reading a recording is a console read (§1.5).
 */
import {
  COMPLETENESS_GAP_KINDS,
  REPLAY_GRADES,
  RUN_ATTESTATION_FIELDS,
} from "@oxagen/tacho";
import { z } from "zod";
import { registerCapability } from "../registry";
import { runPublicIdSchema } from "./run.list";

/** The most frames the gap walk reads before it reports a prefix. */
export const CHAIN_FRAME_CAP = 10_000;

/**
 * How each store chains a frame to the one before it. A verifier recomputes
 * the chain from the frames with this rule and nothing else, so it is answered
 * rather than assumed by the reader.
 */
export const CHAIN_HASH_RULES = [
  /** Wrapped session: `hash = sha256(prev_hash || canonical(event))`. */
  "tacho.sha256_prev_hash_v1",
  /**
   * Evidence ledger: each frame carries `event_digest` over its canonical
   * envelope, and the attempt's `event_stream_digest` folds them in sequence.
   */
  "ledger.event_stream_digest_v1",
] as const;

export const chainHashRuleSchema = z.enum(CHAIN_HASH_RULES);

/** One signed commitment to the chain as it stood at a sequence. */
export const chainCheckpointSchema = z
  .object({
    seq: z.string().regex(/^\d+$/),
    /** The chain head the checkpoint committed to (`sha256:…`). */
    chainHead: z.string(),
    /** Frames the producer had recorded at that point. */
    eventCount: z.number().int().nonnegative(),
    /** RFC 3339. */
    signedAt: z.string().datetime(),
    /** The device key that signed it. */
    deviceKeyFingerprint: z.string(),
    /** The platform key that countersigned it; null when none has. */
    platformKeyId: z.string().nullable(),
    /** RFC 3339; null while the platform has not countersigned. */
    countersignedAt: z.string().datetime().nullable(),
    /** The external anchor the checkpoint was published into; null when none. */
    anchorRoot: z.string().nullable(),
    /** RFC 3339; null when the checkpoint was never anchored. */
    anchoredAt: z.string().datetime().nullable(),
  })
  .strict();

/** A run of sequence numbers the recording does not hold, inclusive. */
export const chainSequenceGapSchema = z
  .object({
    from: z.string().regex(/^\d+$/),
    to: z.string().regex(/^\d+$/),
  })
  .strict();

export const chainGapsSchema = z
  .object({
    /**
     * Sequences missing between the first and the last frame read. The ledger
     * refuses a sequence gap at append, so a ledger run answers none; a
     * wrapped session's producer can drop events, and this is where that shows.
     */
    missingSequences: z.array(chainSequenceGapSchema),
    /** How many sequences the runs above account for. */
    missingFrameCount: z.number().int().nonnegative(),
    /**
     * Frames that carried content and whose bytes were not retained. A
     * `digest_only` recording counts every one of them: the workspace chose it,
     * and the count says what that choice cost the record.
     */
    missingBodies: z.number().int().nonnegative(),
    /** The gaps the seal recorded, from the closed vocabulary (§13.1). */
    recorded: z.array(z.enum(COMPLETENESS_GAP_KINDS)),
  })
  .strict();

export const chainSealSchema = z
  .object({
    /** RFC 3339. */
    sealedAt: z.string().datetime(),
    /** How the attempt ended, as the seal recorded it. */
    terminalStatus: z.string(),
    /** Frames the seal counted. */
    eventCount: z.number().int().nonnegative(),
    /** The last sequence under the seal; null when the attempt recorded none. */
    finalRunSeq: z.string().regex(/^\d+$/).nullable(),
    /** The digest of the last frame; null when the attempt recorded none. */
    finalEventDigest: z.string().nullable(),
    /** The fold of every frame digest in sequence. */
    eventStreamDigest: z.string().nullable(),
    /** The Merkle root over the sealed frames; null on a seal that predates it. */
    merkleRoot: z.string().nullable(),
    /** Where the compacted segment was written; null while none was. */
    archiveSegmentRef: z.string().nullable(),
    /**
     * sha256 over the archive segment's bytes as stored, the digest the
     * attestation signs (#4000). Null on a seal written before the digest was
     * recorded, and on a wrapped session's seal.
     */
    archiveSegmentDigest: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/)
      .nullable(),
    /**
     * The attester's Ed25519 signature over the seal (#4000). It carries the
     * names of the fields it signs over and no copy of their values. This
     * entry lacks four of them (the attempt's public id and the seal's own
     * tier, gaps and grade), so a signature is checked from the export
     * bundle (#4399). Null on a seal written before attestation, on a
     * seal written with no attester key configured, and on a wrapped
     * session's seal.
     */
    attestation: z
      .object({
        alg: z.literal("ed25519"),
        keyId: z.string().min(1),
        /** base64 over the RFC 8785 canonical JSON of the signed payload. */
        sig: z.string().min(1),
        signsOver: z.array(z.enum(RUN_ATTESTATION_FIELDS)).min(1),
      })
      .strict()
      .nullable(),
  })
  .strict();

/** One rung of the replay ladder, and why the recording does or does not reach it. */
export const replayGradeRungSchema = z
  .object({
    grade: z.enum(REPLAY_GRADES),
    met: z.boolean(),
    /**
     * A stable machine-readable reason. A met rung names what carries it
     * (`frames_recorded`, `bodies_retained`, `tool_cassette_complete`,
     * `harness_reproducible`); an unmet one names the single thing missing —
     * a gap kind, `no_retained_bodies`, `observe_tier`, `tool_bodies`,
     * `enforcement_tier:<tier>`, or `harness_not_reproducible`.
     */
    reason: z.string(),
  })
  .strict();

export const runChainGet = registerCapability({
  name: "get_run_chain",
  domain: "run",
  description:
    "Read what makes one run's record tamper-evident: the hash rule, the Merkle root, the signed checkpoints, the sequence and body gaps the recording shows, the seal, and the replay-grade ladder with the reason each rung is or is not reached.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Member: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z
    .object({
      runId: runPublicIdSchema,
    })
    .strict(),
  output: z
    .object({
      runId: runPublicIdSchema,
      hashRule: chainHashRuleSchema,
      /** Frames the walk read. */
      frameCount: z.number().int().nonnegative(),
      /** The first and last sequence read; null on a run with no frame yet. */
      firstSeq: z.string().regex(/^\d+$/).nullable(),
      lastSeq: z.string().regex(/^\d+$/).nullable(),
      /** The root the seal committed to; null while the run is unsealed. */
      merkleRoot: z.string().nullable(),
      checkpoints: z.array(chainCheckpointSchema),
      gaps: chainGapsSchema,
      /**
       * Every seal the run carries, oldest first: one per ledger attempt (a
       * retry or a lease reclaim starts a new one), or the wrapped session's
       * one seal. Empty while the run is unsealed. `merkleRoot` above is the
       * last entry's root, for a quick render; this is the full audit trail,
       * so a retried run does not present one root beside a frame count and
       * gap analysis that span every attempt.
       */
      seals: z.array(chainSealSchema),
      /** Where the run's actions were observed from (spec §8.4). */
      enforcementTier: z.enum(["contained", "gateway", "harness", "observe"]),
      /**
       * The grade the seal recorded; null while the run is live or its seal
       * predates the recorder. The ladder below is computed from what the read
       * can see, so a rung may read stronger than this word — the recorded
       * grade is what a caller renders, and nothing raises it (§8.4).
       */
      recordedGrade: z.enum(REPLAY_GRADES).nullable(),
      ladder: z.array(replayGradeRungSchema),
      /**
       * False when the run has more frames than the walk read, so the gaps are
       * the gaps of a prefix and a caller says so rather than presenting them
       * as the run's.
       */
      complete: z.boolean(),
    })
    .strict(),
});

export type RunChainGetInput = z.output<typeof runChainGet.input>;
export type RunChainGetOutput = z.output<typeof runChainGet.output>;
export type ChainCheckpoint = z.output<typeof chainCheckpointSchema>;
