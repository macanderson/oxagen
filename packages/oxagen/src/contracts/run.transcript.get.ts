/**
 * `get_run_transcript`: one run read as a transcript at one of three zoom
 * levels (Mission Control spec §14 "the transcript at three zoom levels
 * (turns, steps, everything)"; ADR-057).
 *
 * The transcript is derived on the server from the frames and the bodies the
 * recorder kept; nothing here is stored. Each entry names the frame that
 * opens it and the last frame folded into it, carries the text of its body
 * when a body was retained and is UTF-8, and sums the cost records of the
 * frames it folds (§8.4: cumulative cost is a prefix sum over frame cost
 * records, computed on read).
 *
 * - `everything`: one entry per frame.
 * - `steps`: one entry per model call and per tool call; every other frame
 *   folds into the step before it.
 * - `turns`: one entry per turn; a run whose frames carry no turn index is
 *   one turn.
 *
 * A `digest_only` recording produces entries with `text: null` and
 * `fidelity: "digest_only"`, and the transcript says so on every entry; the
 * interface renders that word and nothing stronger (§8.4).
 *
 * `noBillingGate: true`: reading a recording is a console read (§1.5).
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { frameFidelitySchema } from "./run.get";
import { runCostSchema, runPublicIdSchema } from "./run.list";

export const TRANSCRIPT_ZOOMS = ["turns", "steps", "everything"] as const;
export const transcriptZoomSchema = z.enum(TRANSCRIPT_ZOOMS);

/** The most entries one transcript carries; `complete` says when it was cut. */
export const TRANSCRIPT_ENTRY_MAX = 2000;
/** The most UTF-16 units of body text one entry carries. */
export const TRANSCRIPT_TEXT_MAX = 16_384;

export const transcriptEntryKindSchema = z.enum([
  "turn",
  "model_call",
  "tool_call",
  "frame",
]);

export const transcriptEntrySchema = z
  .object({
    /** The frame that opens the entry. */
    seq: z.string().regex(/^\d+$/),
    /** The last frame folded into the entry; equals `seq` for one frame. */
    endSeq: z.string().regex(/^\d+$/),
    /** RFC 3339: when the opening frame was observed. */
    at: z.string().datetime(),
    kind: transcriptEntryKindSchema,
    /** The opening frame's recorded type or kind. */
    type: z.string(),
    /** A short machine-derived label, never prose. */
    label: z.string(),
    /**
     * The body text of the opening frame: null when no body was retained,
     * the body is not UTF-8, or the frame carried no content.
     */
    text: z.string().max(TRANSCRIPT_TEXT_MAX).nullable(),
    /** True when `text` was cut at TRANSCRIPT_TEXT_MAX. */
    truncated: z.boolean(),
    fidelity: frameFidelitySchema,
    /** Frames folded into the entry, the opening frame included. */
    frames: z.number().int().positive(),
    /** The cost records of the folded frames, summed; null when none carried one. */
    cost: runCostSchema.nullable(),
  })
  .strict();

export const runTranscriptGet = registerCapability({
  name: "get_run_transcript",
  domain: "run",
  description:
    "Read one run as a transcript at a zoom level (turns, steps or everything), derived on the server from its frames and retained bodies, with the cost each entry folds.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
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
    })
    .strict(),
  output: z
    .object({
      zoom: transcriptZoomSchema,
      entries: z.array(transcriptEntrySchema).max(TRANSCRIPT_ENTRY_MAX),
      /** False when the run has more frames than the transcript could carry. */
      complete: z.boolean(),
    })
    .strict(),
});

export type RunTranscriptGetInput = z.output<typeof runTranscriptGet.input>;
export type RunTranscriptGetOutput = z.output<typeof runTranscriptGet.output>;
export type TranscriptEntry = z.output<typeof transcriptEntrySchema>;
export type TranscriptZoom = z.output<typeof transcriptZoomSchema>;
