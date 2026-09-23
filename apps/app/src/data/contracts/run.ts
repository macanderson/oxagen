// The Run page's view models (ARCHITECTURE.md §1.2 Run row, §3.3, §3.4;
// WL-35): the header and one page of frames from `get_run`, the cost rollup
// from `get_run_cost`, and the recording read as a transcript from
// `get_run_transcript`.
//
// The header is the same row the Fleet table renders, so a figure cannot read
// one way in the list and another on the page. A field is nullable exactly
// where the contract may not have recorded it, and a null renders as "not
// recorded", never as a zero.
//
// Two slices of the mockup's Run page are not here, because this lane does not
// build them: the Proof tab and the witness run's own tab set (`witnessFor`,
// spec §8.5), which #2955 owns.
import { z } from "zod";
import { Cost } from "./money";
import { EnforcementTier, ReplayGrade, RunRow } from "./runs";

const Count = z.number().int().nonnegative();
const Ratio = z.number().min(0).max(1);

/**
 * What the recorder kept of a frame's content (spec §8.2). `full` retained the
 * redacted bytes; `digest_only` kept the digest and nothing else, and the page
 * says so rather than showing an empty body.
 */
const FrameFidelity = z.enum(["full", "digest_only"]);
type FrameFidelity = z.infer<typeof FrameFidelity>;

/** One removal the redactor made before the body was written (§13.5). */
const FrameRedaction = z.object({
  /** The span removed, in the original bytes. */
  path: z.string(),
  /** The redactor's own word for why. */
  reason: z.string().min(1),
  /** sha256 of the removed bytes, so an auditor can prove what was cut. */
  originalDigest: z.string(),
});

const FrameBody = z.object({
  /** sha256 over the retained bytes; null when the frame carried no content. */
  digest: z.string().nullable(),
  /** Where the bytes were retained; null under `digest_only`. */
  bytesRef: z.string().nullable(),
  redactions: z.array(FrameRedaction),
  fidelity: FrameFidelity,
});

export const RunFrame = z.object({
  /** Opaque resume point: the cursor to read what follows this frame. */
  cursor: z.string(),
  /** The ledger's run-global `run_seq` or a wrapped session's dense `seq`. */
  seq: z.string().regex(/^\d+$/),
  /** The recorded event type, e.g. `model.call_completed`. */
  type: z.string(),
  /** The evidence stage the event belongs to. */
  stage: z.string(),
  observedAt: z.iso.datetime({ offset: true }),
  /** The event's own digest. */
  digest: z.string(),
  /** A short label the contract built from the event's receipt, never prose. */
  summary: z.string(),
  body: FrameBody,
  cost: Cost.nullable(),
});
export type RunFrame = z.infer<typeof RunFrame>;

export const RunFramePage = z.object({
  frames: z.array(RunFrame),
  /** Past every frame this read consumed; null when nothing lay beyond it. */
  cursor: z.string().nullable(),
  /**
   * True when a later page may hold frames: the read carried a resume point
   * and filled the page it was asked for. The contract's cursor is a resume
   * point, not a has-more signal — `get_run` sets it on every non-empty batch
   * so a stream can continue — so a page that came back short is the end of
   * what was recorded, and the pager says so rather than linking to nothing.
   */
  more: z.boolean(),
});
export type RunFramePage = z.infer<typeof RunFramePage>;

/**
 * `get_run_frame_body`: one frame's redacted bytes, read on demand (§3.5).
 * `text` is the body decoded as UTF-8 when it is; a body that is not text
 * keeps its size and content type and says the bytes are not readable here.
 * A `digest_only` frame answers the digest with no bytes at all.
 */
export const RunFrameBody = z.object({
  seq: z.string().regex(/^\d+$/),
  /** Null exactly when no bytes were retained. */
  contentType: z.string().nullable(),
  /** The redacted body as text; null when no bytes were retained or they are not UTF-8. */
  text: z.string().nullable(),
  /** The retained bytes' length; null when none were retained. */
  bytes: z.number().int().nonnegative().nullable(),
  /** sha256 over the redacted bytes, recorded at write. */
  digest: z.string(),
  redactions: z.array(FrameRedaction),
});
export type RunFrameBody = z.infer<typeof RunFrameBody>;

/** `get_run`: the header row and one page of the run's frames. */
export const RunDetail = z.object({
  run: RunRow,
  frames: RunFramePage,
  /**
   * True when this run witnessed another (spec §8.5). The witness tab set is
   * #2955's, so the page states the relation and links no further.
   */
  witnessed: z.boolean(),
});
export type RunDetail = z.infer<typeof RunDetail>;

const TokenCounts = z.object({
  inputUncached: Count,
  cacheRead: Count,
  cacheWrite5m: Count,
  cacheWrite1h: Count,
  output: Count,
  reasoning: Count,
});
export type TokenCounts = z.infer<typeof TokenCounts>;

const RunCostByModel = z.object({
  model: z.string().min(1),
  provider: z.string().nullable(),
  calls: Count,
  cost: Cost.nullable(),
  tokens: TokenCounts,
});

const RunCostByTool = z.object({ name: z.string().min(1), calls: Count });

const RunCostRollup = z.object({
  cost: Cost.nullable(),
  tokens: TokenCounts,
  /** cache_read ÷ (input_uncached + cache_read), spend-weighted. */
  cacheHitRate: Ratio.nullable(),
  turns: Count.nullable(),
  steps: Count,
  modelCalls: Count,
  toolCalls: Count,
  retries: Count.nullable(),
  productiveRatio: Ratio.nullable(),
  byModel: z.array(RunCostByModel),
  byTool: z.array(RunCostByTool),
  /** The price entries the frames were priced with (spec §12.2). */
  priceEntryIds: z.array(z.string()),
  /** When the row was last rebuilt from the frames. */
  rolledUpAt: z.iso.datetime({ offset: true }),
});
export type RunCostRollup = z.infer<typeof RunCostRollup>;

/** `get_run_cost`: null until the rollup has rebuilt the run after its seal. */
export const RunCost = z.object({ rollup: RunCostRollup.nullable() });
export type RunCost = z.infer<typeof RunCost>;

export const TRANSCRIPT_ZOOMS = ["turns", "steps", "everything"] as const;
export const TranscriptZoom = z.enum(TRANSCRIPT_ZOOMS);
export type TranscriptZoom = z.infer<typeof TranscriptZoom>;

const TranscriptEntryKind = z.enum([
  "turn",
  "model_call",
  "tool_call",
  "policy",
  "frame",
]);
type TranscriptEntryKind = z.infer<typeof TranscriptEntryKind>;

/** The chips the Transcript tab filters on, as `get_run_transcript` publishes them. */
export const TRANSCRIPT_KINDS = [
  "prompt",
  "responses",
  "tools",
  "policy",
  "recall",
  "usage",
  "errors",
] as const;
export const TranscriptKind = z.enum(TRANSCRIPT_KINDS);
export type TranscriptKind = z.infer<typeof TranscriptKind>;

/**
 * How many transcript entries one `get_run_transcript` page carries by
 * default, mirrored from that contract's `limit` default so the client can
 * tell a full page from the last one without importing the kernel's contract
 * module. The mirror is asserted against the contract in `run.test.ts`.
 *
 * It is a mirror rather than a re-export because the contract module reaches
 * `@oxagen/run-evidence` and the Context Graph SDK, which import Node
 * builtins and cannot be bundled for the browser.
 */
export const TRANSCRIPT_ENTRY_DEFAULT = 200;

/**
 * One half of an exchange: the frame that carried it, and what it said.
 * `request` is what went out, `response` is what came back — so one tool step
 * shows the input it was called with and the result it returned, in one entry.
 */
/** One block of a model reply: a passage, a thought, a tool the model called, or a result it read. */
const TranscriptBlock = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string() }),
  z.object({ kind: z.literal("thinking"), text: z.string() }),
  z.object({
    kind: z.literal("tool_use"),
    name: z.string().min(1),
    input: z.unknown(),
    callKey: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("tool_result"),
    /** The model's own tool-call id this result answers — not an Oxagen PublicId. */
    forRef: z.string(),
    ok: z.boolean(),
    summary: z.string(),
  }),
]);
type TranscriptBlock = z.infer<typeof TranscriptBlock>;

export const TranscriptBody = z.object({
  seq: z.string().regex(/^\d+$/),
  /**
   * The subagent chain the frame was recorded on; absent on the run's own
   * chain. A subagent's chain is numbered from 0 like the run's, so `seq`
   * names a frame only together with this, and `get_run_frame_body`, which
   * reads the run's own chain, cannot open it.
   */
  chainRef: z.string().optional(),
  type: z.string(),
  /** sha256 over the redacted bytes; null when the frame carried no content. */
  digest: z.string().nullable(),
  /** Where the bytes were retained; null under `digest_only`. */
  bytesRef: z.string().nullable(),
  redactions: z.array(
    z.object({
      path: z.string(),
      reason: z.string(),
      originalDigest: z.string(),
    }),
  ),
  fidelity: FrameFidelity,
  /** The body text; null when none was retained or it is not UTF-8. */
  text: z.string().nullable(),
  /** True when the text was cut at the contract's ceiling. */
  truncated: z.boolean(),
  /**
   * A model reply as the blocks it was: what the model said and the tools it
   * called, when the recorder kept the stream. Absent on every other body.
   */
  blocks: z.array(TranscriptBlock).optional(),
});
export type TranscriptBody = z.infer<typeof TranscriptBody>;

/** A decision a rule or a person made about the call the entry records. */
export const TranscriptDecision = z.object({
  seq: z.string().regex(/^\d+$/),
  /** The subagent chain the decision was recorded on; absent on the run's own. */
  chainRef: z.string().optional(),
  decision: z.string(),
  type: z.string(),
  at: z.iso.datetime({ offset: true }),
});
export type TranscriptDecision = z.infer<typeof TranscriptDecision>;

export const TranscriptUsage = z.object({
  inputUncached: Count.nullable(),
  cacheRead: Count.nullable(),
  cacheWrite: Count.nullable(),
  output: Count.nullable(),
  reasoning: Count.nullable(),
});
export type TranscriptUsage = z.infer<typeof TranscriptUsage>;

export const TranscriptEntry = z.object({
  /** The frame that opens the entry. */
  seq: z.string().regex(/^\d+$/),
  /** The last frame folded into it; equals `seq` for a single frame. */
  endSeq: z.string().regex(/^\d+$/),
  /**
   * The subagent whose chain the opening frame was recorded on; absent on the
   * run's own chain. `chainRef` is that chain's session uuid, which a
   * subagent's `seq` needs beside it to name one frame (`entryKey`).
   */
  subagent: z
    .object({ chainRef: z.string(), type: z.string().nullable() })
    .optional(),
  at: z.iso.datetime({ offset: true }),
  /** Milliseconds from the run's recorded start; never negative. */
  elapsedMs: z.number().int().nonnegative(),
  kind: TranscriptEntryKind,
  /** The opening frame's recorded type. */
  type: z.string(),
  /** A short machine-derived label, never prose. */
  label: z.string(),
  /**
   * The call the opening frame belongs to. Null when the producer recorded
   * none. Named `callKey` and not `callId` because it is not a public id: the
   * producer writes a free-text call identifier (`tool_call_id`,
   * `model_call_id`, `toolUseId`), and a field spelled `Id` here must carry
   * a `PublicId` (src/test/arch/public-ids.test.ts).
   */
  callKey: z.string().nullable(),
  usage: TranscriptUsage.nullable().optional(),
  /** The chips this entry answers to. */
  kinds: z.array(TranscriptKind),
  request: TranscriptBody.nullable(),
  response: TranscriptBody.nullable(),
  decision: TranscriptDecision.nullable(),
  /** Frames folded into the entry, the opening frame included. */
  frames: z.number().int().positive(),
  /** The turn the opening frame falls in, 1-based; null before the run's first turn. */
  turn: z.number().int().positive().nullable(),
  cost: Cost.nullable(),
  /** Every cost record of the run up to and including this entry. */
  cumulativeCost: Cost.nullable(),
});
export type TranscriptEntry = z.infer<typeof TranscriptEntry>;

/** `get_run_transcript` at one zoom level. */
export const RunTranscript = z.object({
  zoom: TranscriptZoom,
  kinds: z.array(TranscriptKind),
  entries: z.array(TranscriptEntry),
  /** The point to continue from; null when nothing lies past this page. */
  cursor: z.string().nullable(),
  /** False when the run has more frames than one transcript could carry. */
  complete: z.boolean(),
});
export type RunTranscript = z.infer<typeof RunTranscript>;

/**
 * `get_run_chain`: what makes the recording tamper-evident, and what it is
 * missing (spec §8.3, §8.4). Read once, when the Chain and seal tab opens.
 *
 * `recordedGrade` is the grade the seal wrote, and it is the only grade a
 * surface renders. The ladder below it says why each rung is or is not
 * reached, computed from what the read could see, so a rung may read stronger
 * than the recorded word. Nothing here raises the grade (§8.4).
 */
const ChainCheckpoint = z.object({
  seq: z.string().regex(/^\d+$/),
  /** The chain head the checkpoint committed to. */
  chainHead: z.string(),
  eventCount: Count,
  signedAt: z.iso.datetime({ offset: true }),
  deviceKeyFingerprint: z.string(),
  /**
   * The platform key that countersigned the checkpoint; null until one has.
   *
   * Named `platformKey` and not `platformKeyId` because it is not a public id:
   * the store holds free text (`tacho_checkpoints.platform_key_id`), which is
   * a signing-key identifier of whatever shape the signer uses (including
   * shapes like `pk:1`), the same kind of thing as `deviceKeyFingerprint`
   * beside it. A field spelled `…Id` here must carry a `PublicId`
   * (src/test/arch/public-ids.test.ts), and forcing that shape on this one
   * would refuse a real checkpoint whose key is not spelled like a public id.
   */
  platformKey: z.string().nullable(),
  countersignedAt: z.iso.datetime({ offset: true }).nullable(),
  /** The external anchor it was published into; null when none. */
  anchorRoot: z.string().nullable(),
  anchoredAt: z.iso.datetime({ offset: true }).nullable(),
});
export type ChainCheckpoint = z.infer<typeof ChainCheckpoint>;

const COMPLETENESS_GAPS = [
  "digest_only",
  "body_missing",
  "tool_bodies",
  "model_calls",
  "hooks_partial",
  "unobserved_tail",
  "chain_break",
  "telemetry_gap",
] as const;

const ChainGaps = z.object({
  /** Runs of sequence numbers the recording does not hold, inclusive. */
  missingSequences: z.array(
    z.object({
      from: z.string().regex(/^\d+$/),
      to: z.string().regex(/^\d+$/),
    }),
  ),
  missingFrameCount: Count,
  /** Frames that carried content whose bytes were not retained. */
  missingBodies: Count,
  /** The gaps the seal itself recorded. */
  recorded: z.array(z.enum(COMPLETENESS_GAPS)),
});

const ChainSeal = z.object({
  sealedAt: z.iso.datetime({ offset: true }),
  terminalStatus: z.string(),
  eventCount: Count,
  finalRunSeq: z.string().regex(/^\d+$/).nullable(),
  finalEventDigest: z.string().nullable(),
  eventStreamDigest: z.string().nullable(),
  /** Null on a seal that predates the Merkle root. */
  merkleRoot: z.string().nullable(),
  archiveSegmentRef: z.string().nullable(),
});

/** One rung of the replay ladder, and the machine-readable reason it stands where it does. */
const ReplayLadderRung = z.object({
  grade: ReplayGrade,
  met: z.boolean(),
  reason: z.string().min(1),
});

export const RunChain = z.object({
  /** How each frame is chained to the one before it; a verifier needs this and nothing else. */
  hashRule: z.enum([
    "tacho.sha256_prev_hash_v1",
    "ledger.event_stream_digest_v1",
  ]),
  /** Frames the walk read. */
  frameCount: Count,
  firstSeq: z.string().regex(/^\d+$/).nullable(),
  lastSeq: z.string().regex(/^\d+$/).nullable(),
  /** Null while the run is unsealed. */
  merkleRoot: z.string().nullable(),
  /** A ledger run keeps none: it seals rather than checkpointing. */
  checkpoints: z.array(ChainCheckpoint),
  gaps: ChainGaps,
  /** One seal per attempt, oldest first; empty while the run is unsealed. */
  seals: z.array(ChainSeal),
  enforcementTier: EnforcementTier,
  recordedGrade: ReplayGrade.nullable(),
  ladder: z.array(ReplayLadderRung),
  /** False when the run has more frames than the walk read, so these are a prefix's gaps. */
  complete: z.boolean(),
});
export type RunChain = z.infer<typeof RunChain>;

// ---- Outputs ---------------------------------------------------------------

/**
 * What a run produced, from `get_run_outputs`: the Run page's spine.
 *
 * One node per thing the run produced, in the order the frames produced it. A
 * read is a node too, so the spine can draw its hairline tick and the tally
 * can count it apart; it is never an artifact.
 */
const RunOutputKind = z.enum([
  "file",
  "media",
  "change",
  "commit",
  "pr",
  "gate",
  "would",
  "read",
]);
export type RunOutputKind = z.infer<typeof RunOutputKind>;

const RunOutputState = z.enum([
  "created",
  "written",
  "deleted",
  "renamed",
  "pushed",
  "open",
  "read",
  "awaiting",
  "blocked",
  "withheld",
]);
export const RunOutputNode = z.object({
  /** The frame that produced it, for the `fr N` chip; null on a gate, which the record gives no frame. */
  seq: z.string().regex(/^\d+$/).nullable(),
  kind: RunOutputKind,
  /** The mono name: a path, a commit sha, `#482`, a capability, or a path locator. */
  name: z.string().min(1),
  /**
   * True when `name` is an opaque locator rather than a path. The ledger
   * records a change without its path, and the spine says so rather than
   * printing `rpl_…` where a filename belongs.
   */
  nameIsLocator: z.boolean(),
  /** Where it landed; null renders as nothing, never as a blank guess. */
  where: z.string().nullable(),
  state: RunOutputState,
  note: z.string().nullable(),
  stat: z.object({ added: Count, removed: Count }).nullable(),
  observedAt: z.iso.datetime({ offset: true }).nullable(),
  digestBefore: z.string().nullable(),
  digestAfter: z.string().nullable(),
});
export type RunOutputNode = z.infer<typeof RunOutputNode>;

export const RunOutputs = z.object({
  /** Which store recorded the run: the node shapes differ by store. */
  source: z.enum(["wrapped", "ledger"]),
  nodes: z.array(RunOutputNode),
  tally: z.object({ artifacts: Count, reads: Count, gates: Count }),
  /** False when the read stopped at its cap, so the spine is a prefix. */
  complete: z.boolean(),
});
export type RunOutputs = z.infer<typeof RunOutputs>;
