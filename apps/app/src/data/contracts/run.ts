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
import { RunRow } from "./runs";

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
  "frame",
]);
type TranscriptEntryKind = z.infer<typeof TranscriptEntryKind>;

export const TranscriptEntry = z.object({
  /** The frame that opens the entry. */
  seq: z.string().regex(/^\d+$/),
  /** The last frame folded into it; equals `seq` for a single frame. */
  endSeq: z.string().regex(/^\d+$/),
  at: z.iso.datetime({ offset: true }),
  kind: TranscriptEntryKind,
  /** The opening frame's recorded type. */
  type: z.string(),
  /** A short machine-derived label, never prose. */
  label: z.string(),
  /** The opening frame's body text; null when none was retained or it is not UTF-8. */
  text: z.string().nullable(),
  /** True when the text was cut at the contract's ceiling. */
  truncated: z.boolean(),
  fidelity: FrameFidelity,
  /** Frames folded into the entry, the opening frame included. */
  frames: z.number().int().positive(),
  /** The turn the opening frame falls in, 1-based; null before the run's first turn. */
  turn: z.number().int().positive().nullable(),
  cost: Cost.nullable(),
});
export type TranscriptEntry = z.infer<typeof TranscriptEntry>;

/** `get_run_transcript` at one zoom level. */
export const RunTranscript = z.object({
  zoom: TranscriptZoom,
  entries: z.array(TranscriptEntry),
  /** False when the run has more frames than one transcript could carry. */
  complete: z.boolean(),
});
export type RunTranscript = z.infer<typeof RunTranscript>;
