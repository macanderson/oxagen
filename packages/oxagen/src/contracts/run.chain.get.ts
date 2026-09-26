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
 * A wrapped run's subagents each record on a hash chain of their own, with
 * their own dense `seq` from 0, their own session row and their own
 * checkpoints (#3823). Gaps cannot be computed over spliced frames, so each
 * subagent chain is answered on its own in `chains`, and the top-level
 * figures keep describing the run's own chain.
 *
 * No new store: the ledger's seal rows, the wrapped session's checkpoints and
 * the frames already recorded are all it reads.
 *
 * `noBillingGate: true`: reading a recording is a console read (§1.5).
 */
import { COMPLETENESS_GAP_KINDS, REPLAY_GRADES } from "@oxagen/tacho";
import { z } from "zod";
import { registerCapability } from "../registry";
import { runPublicIdSchema } from "./run.list";

/** The most frames the gap walk reads before it reports a prefix. */
export const CHAIN_FRAME_CAP = 10_000;

/** The most subagent chains one read answers. */
export const CHAIN_SUBAGENTS_MAX = 200;

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

/**
 * One subagent chain of a wrapped run, walked on its own: its place in the
 * run, its frames, its gaps, its checkpoints and its seal.
 */
export const chainSubagentSchema = z
  .object({
    sessionUuid: z.string().uuid(),
    /** The chain that spawned this one; null when none was recorded. */
    parentSessionUuid: z.string().uuid().nullable(),
    /** The harness's id for the subagent; null when none was recorded. */
    subagentId: z.string().nullable(),
    /** The subagent's type (`Explore`, `general-purpose`); null when none was recorded. */
    subagentType: z.string().nullable(),
    /** Frames the walk read on this chain. */
    frameCount: z.number().int().nonnegative(),
    /** The first and last sequence read on this chain; null when it holds none. */
    firstSeq: z.string().regex(/^\d+$/).nullable(),
    lastSeq: z.string().regex(/^\d+$/).nullable(),
    /** The chain's own gaps, numbered on the chain's own `seq`. */
    gaps: z
      .object({
        missingSequences: z.array(chainSequenceGapSchema),
        missingFrameCount: z.number().int().nonnegative(),
        missingBodies: z.number().int().nonnegative(),
      })
      .strict(),
    checkpoints: z.array(chainCheckpointSchema),
    /** The chain's last hash at its seal; null while it is unsealed. */
    finalHash: z.string().nullable(),
    /** RFC 3339; null while the chain is unsealed. */
    sealedAt: z.string().datetime().nullable(),
    /** False when the walk stopped before this chain's last frame. */
    complete: z.boolean(),
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
    "Read what makes one run's record tamper-evident: the hash rule, the Merkle root, the signed checkpoints, the sequence and body gaps the recording shows, the seal, and the replay-grade ladder with the reason each rung is or is not reached. A wrapped run's subagent chains are answered one by one.",
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
      /** Frames the walk read on the run's own chain. */
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
      /**
       * Each subagent chain of a wrapped run, walked on its own, in the order
       * the chains started. Absent on a ledger run. `frameCount`, `firstSeq`,
       * `lastSeq` and `gaps` above describe the run's own chain only.
       */
      chains: z.array(chainSubagentSchema).max(CHAIN_SUBAGENTS_MAX).optional(),
    })
    .strict(),
});

export type RunChainGetInput = z.output<typeof runChainGet.input>;
export type RunChainGetOutput = z.output<typeof runChainGet.output>;
export type ChainCheckpoint = z.output<typeof chainCheckpointSchema>;
export type ChainSubagent = z.output<typeof chainSubagentSchema>;
