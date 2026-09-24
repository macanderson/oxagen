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
/** The most UTF-16 units of body text one half carries at `everything`. */
export const TRANSCRIPT_TEXT_MAX = 16_384;
/**
 * The same, at `turns` and `steps`, where an entry stands for a whole exchange
 * rather than one frame.
 *
 * A folded zoom is a reading of the run, not the run's bytes: a page of 200
 * steps at the full cap is several megabytes of body text nobody asked for on
 * that render. An excerpt plus the entry's `label` is what those levels are
 * for, and a half cut here says `truncated: true`, so a reader follows the
 * frame to `get_run_frame_body` for the whole of it. `everything` is one entry
 * per frame and keeps the full cap.
 */
export const TRANSCRIPT_STEP_TEXT_MAX = 1_024;

/** The text cap a zoom level reads under. */
export function transcriptTextMax(
  zoom: z.output<typeof transcriptZoomSchema>,
): number {
  return zoom === "everything" ? TRANSCRIPT_TEXT_MAX : TRANSCRIPT_STEP_TEXT_MAX;
}

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

/**
 * The longest a string field inside a tool call's input is carried before it
 * is folded to its length. A `Write` call's content is the file, and a page
 * of steps that carried every one of them would be the same mistake the wire
 * was: bytes nobody asked for on that render. The whole input is always one
 * `get_run_frame_body` away.
 */
export const TRANSCRIPT_FIELD_MAX = 400;

/** Fields every reassembled block carries. */
const blockBaseShape = {
  /** Stable within the frame, so a deep link to a block survives a reload. */
  id: z.string().min(1),
  /** Characters the block renders as. */
  chars: z.number().int().nonnegative(),
  /** The block's apportioned share of the message's output tokens. */
  tokens: z.number().int().nonnegative(),
  /** True when the stream ended before this block closed. */
  partial: z.boolean(),
  /**
   * The block's share of the step's output spend, priced at the model's
   * output rate. Null when the price book prices no output for this model: a
   * figure nobody can price is left out, never drawn as a zero.
   */
  cost: runCostSchema.nullable(),
} as const;

/** What a rule or a person decided about the call a `tool_use` block made. */
export const toolVerdictSchema = z
  .object({
    answer: z.enum(["allowed", "denied", "routed"]),
    /** The rule that answered, as the record spells it. */
    rule: z.string(),
    /** How long the decision took; null when the record did not time it. */
    ms: z.number().int().nonnegative().nullable(),
    /** Who the call waits on while it is routed; null otherwise. */
    waitingOn: z.string().nullable(),
  })
  .strict();

export const contentBlockSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...blockBaseShape,
      kind: z.literal("text"),
      text: z.string().max(TRANSCRIPT_TEXT_MAX),
      /** True when `text` was cut at the cap, on a line boundary. */
      truncated: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...blockBaseShape,
      kind: z.literal("thinking"),
      text: z.string().max(TRANSCRIPT_TEXT_MAX),
      truncated: z.boolean(),
      /** Wall seconds the block took; null when the record did not time it. */
      seconds: z.number().nonnegative().nullable(),
    })
    .strict(),
  z
    .object({
      ...blockBaseShape,
      kind: z.literal("tool_use"),
      name: z.string().min(1),
      /** The parsed input, or the raw fragment string when it did not parse. */
      input: z.unknown(),
      /** True when `input` is the raw string rather than parsed JSON. */
      inputRaw: z.boolean(),
      /** True when a string field was folded to its length (§ TRANSCRIPT_FIELD_MAX). */
      inputFolded: z.boolean(),
      /** The producer's own id for the call, so a result attaches to it. */
      callKey: z.string().nullable(),
      verdict: toolVerdictSchema.nullable(),
    })
    .strict(),
  z
    .object({
      ...blockBaseShape,
      kind: z.literal("tool_result"),
      /** The `tool_use` block this result answers. */
      forId: z.string().min(1),
      ok: z.boolean(),
      /** One line: what came back, never the whole payload. */
      summary: z.string(),
      bytes: z.number().int().nonnegative().nullable(),
      ms: z.number().int().nonnegative().nullable(),
    })
    .strict(),
]);

/** The token counts the provider reported, split so no total hides a cache hit. */
export const assemblyUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().nullable(),
    cacheReadTokens: z.number().int().nonnegative().nullable(),
    cacheWriteTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
  })
  .strict();

/**
 * A recorded model stream as the message it was: the fold the ledger wrote
 * beside the wire at ingest, never computed here and never computed in a
 * viewer.
 *
 * A half that carries one carries no `text`: the wire is the transport, the
 * blocks are the message, and a list that shipped both would ship the bytes
 * this exists to keep off the page. The recorded bytes stay one
 * `get_run_frame_body` away, byte for byte.
 */
export const transcriptAssemblySchema = z
  .object({
    blocks: z.array(contentBlockSchema),
    /**
     * The step's one line, built by template from the block kinds. Pure: the
     * same frame gives the same line on every read, and no model wrote it.
     */
    precis: z.string(),
    /** The provider's stop reason, verbatim; null when the stream did not say. */
    stopReason: z.string().nullable(),
    /** Milliseconds to the first content delta; null when nothing timed it. */
    ttftMs: z.number().int().nonnegative().nullable(),
    /** The call's wall time; null when nothing timed it. */
    durationMs: z.number().int().nonnegative().nullable(),
    /** Output tokens per second of wall time; null without both figures. */
    tokensPerSecond: z.number().nonnegative().nullable(),
    usage: assemblyUsageSchema,
    /** True when the stream ended before the message did. */
    partial: z.boolean(),
    /** What the transport was, for the tier that shows it. */
    wire: z
      .object({
        events: z.number().int().nonnegative(),
        bytes: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

/** One half of an exchange: the frame that carried it, and what it said. */
export const transcriptBodySchema = z
  .object({
    /** The frame this half was recorded on. */
    seq: z.string().regex(/^\d+$/),
    /**
     * The subagent chain the frame was recorded on; absent on the run's own
     * chain. A subagent's chain is numbered from 0 like the run's, so `seq`
     * names a frame only together with this.
     */
    sessionUuid: z.string().uuid().optional(),
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
    /**
     * The recorded model stream folded into the message it was, or null when
     * this half is not one (a prompt, a tool argument, a tool result).
     *
     * Non-null exactly when `text` is null for a retained body: the two are
     * alternatives, never both. A reader shows the blocks, and reaches for
     * the wire through `get_run_frame_body` only when a person asks for the
     * transport.
     */
    assembly: transcriptAssemblySchema.nullable(),
  })
  .strict();

/** A decision a rule or a person made about the call the entry records. */
export const transcriptDecisionSchema = z
  .object({
    seq: z.string().regex(/^\d+$/),
    /** The subagent chain the decision was recorded on; absent on the run's own. */
    sessionUuid: z.string().uuid().optional(),
    /**
     * The recorded word: `allow`, `deny`, `route`, or whatever the rule
     * wrote. An operator command (`oxagen:command_applied`) records the
     * command: `pause`, `resume`, `cancel` or `steer`.
     */
    decision: z.string(),
    type: z.string(),
    /**
     * Who decided, in the envelope's `policy_source` words: `bundle` and
     * `kernel` are Oxagen policy, `human` is an operator, `harness` and
     * `managed_settings` are the agent's harness checking itself. Null when
     * the frame names none.
     */
    source: z.string().nullable().optional(),
    /** RFC 3339. */
    at: z.string().datetime(),
  })
  .strict();

export const transcriptUsageSchema = z
  .object({
    inputUncached: z.number().int().nonnegative().nullable(),
    cacheRead: z.number().int().nonnegative().nullable(),
    cacheWrite: z.number().int().nonnegative().nullable(),
    output: z.number().int().nonnegative().nullable(),
    reasoning: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const transcriptEntrySchema = z
  .object({
    /** The frame that opens the entry. */
    seq: z.string().regex(/^\d+$/),
    /** The last frame folded into the entry; equals `seq` for one frame. */
    endSeq: z.string().regex(/^\d+$/),
    /**
     * The subagent whose chain the opening frame was recorded on; absent on
     * the run's own chain. A wrapped run's subagents record on chains of
     * their own, each numbered from 0, and the transcript places each chain
     * directly after the `subagent_start` that spawned it. `seq` and `endSeq`
     * are positions on that chain, so they name a frame only together with
     * `sessionUuid`; `get_run_frame_body` reads the run's own chain.
     */
    subagent: z
      .object({
        sessionUuid: z.string().uuid(),
        /** The harness's id for the subagent; null when none was recorded. */
        id: z.string().nullable(),
        /** The subagent's type (`Explore`, `general-purpose`); null when none was recorded. */
        type: z.string().nullable(),
        /**
         * The parent's tool call that spawned the subagent (the Task or Agent
         * call's `tool_use_id`), so a client nests the subagent under it.
         * Null when none was recorded.
         */
        spawnCallId: z.string().nullable().optional(),
      })
      .strict()
      .optional(),
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
    /**
     * The call the opening frame belongs to (`tool_call_id`, `model_call_id`,
     * or a wrapped session's `toolUseId`). Null when the producer recorded
     * none. Clients that rebuild steps at `everything` pair halves on this
     * value rather than on adjacency, so overlapping tool calls keep each
     * result under the request that made it.
     */
    callId: z.string().nullable(),
    /**
     * What the opening frame's tool call acts on, as the gate recorded it: the
     * command, path or URL, capped at 400 characters. Null when the frame
     * names none.
     */
    target: z.string().nullable().optional(),
    /**
     * The reasoning effort the model call ran at (`low`, `medium`, `high`),
     * as the harness recorded it. Null when none was recorded.
     */
    effort: z.string().max(32).nullable().optional(),
    usage: transcriptUsageSchema.nullable().optional(),
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
    /**
     * The turn the opening frame belongs to, 1-based. Null for a frame
     * recorded before the run's first `turn_start` (the agent starting and
     * the context it was handed); a recording with no turn boundaries puts
     * every frame in a turn. The same value at every zoom, so a client can
     * group `everything` entries into the turns the `turns` zoom folds.
     */
    turn: z.number().int().positive().nullable(),
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
export type TranscriptAssembly = z.output<typeof transcriptAssemblySchema>;
export type TranscriptContentBlock = z.output<typeof contentBlockSchema>;
export type TranscriptToolVerdict = z.output<typeof toolVerdictSchema>;
