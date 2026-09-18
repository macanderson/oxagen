/**
 * `get_run_transcript`: one run read as a transcript at one of three zoom
 * levels (Mission Control spec §14 "the transcript at three zoom levels
 * (turns, steps, everything)"; §8.4; ADR-058).
 *
 * The transcript is derived on the server from the frames and the bodies the
 * recorder kept; nothing here is stored. Each entry names the frame that opens
 * it and the last frame folded into it, and carries the two halves of the
 * exchange it records:
 *
 * - `request` is what went out — the prompt a model call was made with, the
 *   input a tool was called with.
 * - `response` is what came back — the model's reply, the tool's result. A
 *   producer that appends a single terminal receipt for the whole exchange
 *   records it as the `response`, because its body is the result.
 *
 * Each half carries its own digest, redactions, fidelity and text, so a reader
 * can prove what it was shown against the chain. One tool step is one entry
 * with both halves; before this it was two entries, each with half the
 * exchange and no way to tell which call the other half belonged to.
 *
 * - `everything`: one entry per frame, so the two halves of a step are two
 *   entries, each with its own body.
 * - `steps`: one entry per model call and per tool call, request and response
 *   folded together; every other frame folds into the step before it.
 * - `turns`: one entry per turn; a run whose frames carry no turn index is one
 *   turn.
 *
 * Cost is a prefix sum over `seq` (§8.4): `cost` is what the entry's own
 * frames recorded and `cumulativeCost` is every frame of the run up to and
 * including it, so a reader never has to add up a page to know what a run had
 * spent by a given step. Both are null where no frame carried a cost record.
 *
 * `kinds` is the Transcript tab's chips, applied on the server: the filter
 * selects frames and the fold runs over what is left, so a filtered transcript
 * is the transcript of those frames. An empty selection keeps everything.
 *
 * A `digest_only` recording produces halves with `text: null` and
 * `fidelity: "digest_only"`, and the transcript says so on every half; the
 * interface renders that word and nothing stronger (§8.4).
 *
 * `noBillingGate: true`: reading a recording is a console read (§1.5).
 */
import { TRANSCRIPT_KINDS } from "@oxagen/tacho";
import { z } from "zod";
import { registerCapability } from "../registry";
import { frameFidelitySchema, frameRedactionSchema } from "./run.get";
import { runCostSchema, runPublicIdSchema } from "./run.list";

export const TRANSCRIPT_ZOOMS = ["turns", "steps", "everything"] as const;
export const transcriptZoomSchema = z.enum(TRANSCRIPT_ZOOMS);

/** The most entries one page carries. */
export const TRANSCRIPT_ENTRY_MAX = 500;
export const TRANSCRIPT_ENTRY_DEFAULT = 200;
/** The most UTF-16 units of body text one half carries. */
export const TRANSCRIPT_TEXT_MAX = 16_384;

/**
 * The chips the Transcript tab filters on. The mockup also draws a `thinking`
 * chip; no producer records a reasoning segment in this revision, so there is
 * no kind for it — a chip that can only ever answer "none" would be the
 * placeholder §3.4 forbids.
 */
export const transcriptKindSchema = z.enum(TRANSCRIPT_KINDS);

export const transcriptEntryKindSchema = z.enum([
  "turn",
  "model_call",
  "tool_call",
  "policy",
  "frame",
]);

/** One half of an exchange: the frame that carried it, and what it said. */
export const transcriptBodySchema = z
  .object({
    /** The frame this half was recorded on. */
    seq: z.string().regex(/^\d+$/),
    /** The frame's recorded type or kind. */
    type: z.string(),
    /** sha256 over the redacted bytes; null when the frame carried no content. */
    digest: z.string().nullable(),
    /** Where the bytes were retained; null under `digest_only`. */
    bytesRef: z.string().nullable(),
    redactions: z.array(frameRedactionSchema),
    fidelity: frameFidelitySchema,
    /**
     * The body text: null when no body was retained, the body is not UTF-8,
     * or the frame carried no content.
     */
    text: z.string().max(TRANSCRIPT_TEXT_MAX).nullable(),
    /** True when `text` was cut at TRANSCRIPT_TEXT_MAX. */
    truncated: z.boolean(),
  })
  .strict();

/** A decision a rule or a person made about the call the entry records. */
export const transcriptDecisionSchema = z
  .object({
    seq: z.string().regex(/^\d+$/),
    /** The recorded word: `allow`, `deny`, `route`, or whatever the rule wrote. */
    decision: z.string(),
    type: z.string(),
    /** RFC 3339. */
    at: z.string().datetime(),
  })
  .strict();

export const transcriptEntrySchema = z
  .object({
    /** The frame that opens the entry. */
    seq: z.string().regex(/^\d+$/),
    /** The last frame folded into the entry; equals `seq` for one frame. */
    endSeq: z.string().regex(/^\d+$/),
    /** RFC 3339: when the opening frame was observed. */
    at: z.string().datetime(),
    /**
     * Milliseconds from the run's start to the opening frame. Clamped at zero:
     * a producer whose clock puts a frame before the run's recorded start
     * reports 0, never a negative elapsed time.
     */
    elapsedMs: z.number().int().nonnegative(),
    kind: transcriptEntryKindSchema,
    /** The opening frame's recorded type or kind. */
    type: z.string(),
    /** A short machine-derived label, never prose. */
    label: z.string(),
    /** The chips this entry answers to, from the frames it folds. */
    kinds: z.array(transcriptKindSchema),
    /** What went out; null when the recording has only the terminal receipt. */
    request: transcriptBodySchema.nullable(),
    /** What came back; null when only a write-ahead intention was recorded. */
    response: transcriptBodySchema.nullable(),
    /** The decision folded into the entry; null when none was. */
    decision: transcriptDecisionSchema.nullable(),
    /** Frames folded into the entry, the opening frame included. */
    frames: z.number().int().positive(),
    /** The cost records of the folded frames, summed; null when none carried one. */
    cost: runCostSchema.nullable(),
    /** Every cost record up to and including this entry (§8.4 prefix sum). */
    cumulativeCost: runCostSchema.nullable(),
  })
  .strict();

export const runTranscriptGet = registerCapability({
  name: "get_run_transcript",
  domain: "run",
  description:
    "Read one run as a transcript at a zoom level (turns, steps or everything), derived on the server from its frames and retained bodies: each step one entry carrying the request and the result it was made with, the decision folded into it, and its own and the run's cumulative cost.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Member: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z
    .object({
      runId: runPublicIdSchema,
      zoom: transcriptZoomSchema,
      /** The chips pressed; empty or omitted keeps every frame. */
      kinds: z
        .array(transcriptKindSchema)
        .max(TRANSCRIPT_KINDS.length)
        .default([]),
      /** An entry cursor from an earlier read; omitted reads from the start. */
      after: z.string().max(256).optional(),
      limit: z
        .number()
        .int()
        .min(1)
        .max(TRANSCRIPT_ENTRY_MAX)
        .default(TRANSCRIPT_ENTRY_DEFAULT),
    })
    .strict(),
  output: z
    .object({
      zoom: transcriptZoomSchema,
      kinds: z.array(transcriptKindSchema),
      entries: z.array(transcriptEntrySchema).max(TRANSCRIPT_ENTRY_MAX),
      /** The point to continue from; null when nothing lies past this page. */
      cursor: z.string().nullable(),
      /**
       * False when the run has more frames than the read could fold, so the
       * transcript is a prefix and the caller says so rather than presenting
       * it as the whole.
       */
      complete: z.boolean(),
    })
    .strict(),
});

export type RunTranscriptGetInput = z.output<typeof runTranscriptGet.input>;
export type RunTranscriptGetOutput = z.output<typeof runTranscriptGet.output>;
export type TranscriptEntry = z.output<typeof transcriptEntrySchema>;
export type TranscriptEntryBody = z.output<typeof transcriptBodySchema>;
export type TranscriptZoom = z.output<typeof transcriptZoomSchema>;
export type TranscriptKind = z.output<typeof transcriptKindSchema>;
