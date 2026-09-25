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
 *   folded together, and one per event: a prompt, a reply, a decision on no
 *   recorded call, a recall. A step never crosses a turn boundary.
 * - `turns`: the `steps` entries grouped by turn, so the two zooms agree on
 *   what a turn holds; a run whose frames carry no turn index is one turn.
 *
 * The server is the only place a transcript is folded (ADR-182). A client
 * presents these entries and does not pair, group or count frames of its own.
 *
 * Cost is a prefix sum over `seq` (§8.4): `cost` is what the entry's own
 * frames recorded and `cumulativeCost` is every frame of the run up to and
 * including it, so a reader never has to add up a page to know what a run had
 * spent by a given step. Both are null where no frame carried a cost record.
 *
 * `kinds` is the Transcript tab's chips, applied on the server after the fold:
 * the filter keeps the entries that answer a chip pressed, so a filtered
 * transcript shows the same steps as an unfiltered one, only fewer of them.
 * An empty selection keeps everything.
 *
 * `query` searches the folded entries on the server (#3942): an entry
 * matches when its label, its tool, its target, or the text of either half
 * holds the query, ignoring case. The chips narrow first, then the query,
 * and the matches page on the same cursor. A search reads bodies, so a read
 * searches at most `TRANSCRIPT_SEARCH_HALF_MAX` halves and says in
 * `search.unsearched` how many halves it could not search.
 *
 * `counts` and `figures` are counted over the whole run read, whatever the
 * chips or the query, so a reader's counts and figures never move when it
 * narrows the transcript. They share the read's frame cap: when `complete`
 * is false they cover a prefix of the run.
 *
 * A `digest_only` recording produces halves with `text: null` and
 * `fidelity: "digest_only"`, and the transcript says so on every half; the
 * interface renders that word and nothing stronger (§8.4).
 *
 * `noBillingGate: true`: reading a recording is a console read (§1.5).
 */
import {
  TOOL_FAMILIES,
  TRANSCRIPT_KINDS,
  TRANSCRIPT_NODES,
  TRANSCRIPT_OUTCOMES,
} from "@oxagen/tacho";
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

/**
 * How much of each half's body a read carries: `excerpt` cuts it at
 * `TRANSCRIPT_STEP_TEXT_MAX`, `full` at `TRANSCRIPT_TEXT_MAX`. A read that
 * names neither takes its zoom's cap, so a caller that never asked keeps the
 * answer it had. The Run page asks for `full` at `steps`, so a tool's output
 * is not cut at a kilobyte.
 */
export const TRANSCRIPT_TEXTS = ["excerpt", "full"] as const;
export const transcriptTextSchema = z.enum(TRANSCRIPT_TEXTS);

/** The text cap a read carries its halves under. */
export function transcriptTextMax(
  zoom: z.output<typeof transcriptZoomSchema>,
  text?: z.output<typeof transcriptTextSchema>,
): number {
  if (text === "full") return TRANSCRIPT_TEXT_MAX;
  if (text === "excerpt") return TRANSCRIPT_STEP_TEXT_MAX;
  return zoom === "everything" ? TRANSCRIPT_TEXT_MAX : TRANSCRIPT_STEP_TEXT_MAX;
}

/** The longest search a read takes, in characters. */
export const TRANSCRIPT_QUERY_MAX = 200;

/**
 * The most halves one search reads to look inside. A search can reach every
 * body a run kept, which is up to one per frame. Past this the read stops
 * reading bodies, still matches the rest on their label, tool and target,
 * and counts the halves it did not read in `search.unsearched`.
 */
export const TRANSCRIPT_SEARCH_HALF_MAX = 2_000;

/**
 * Where a search found the query in an entry: its `label`, its `subject`,
 * its `target`, or the text of its `request` or `response` half. For a half
 * that carries an assembly, the text is its blocks: what the model said and
 * thought, each tool it called with the input, and each result's summary.
 * An entry that matched on its label, subject or target has no half read, so
 * its matches name only those.
 */
export const TRANSCRIPT_MATCHES = [
  "label",
  "subject",
  "target",
  "request",
  "response",
] as const;
export const transcriptMatchSchema = z.enum(TRANSCRIPT_MATCHES);

/**
 * The chips the Transcript tab filters on, in the order the page draws them
 * (`TRANSCRIPT_KINDS` in `@oxagen/tacho` says what each selects).
 */
export const transcriptKindSchema = z.enum(TRANSCRIPT_KINDS);

/** What kind of row a folded entry is (`TRANSCRIPT_NODES` in `@oxagen/tacho`). */
export const transcriptNodeSchema = z.enum(TRANSCRIPT_NODES);

/** How an entry's call ended (`TRANSCRIPT_OUTCOMES` in `@oxagen/tacho`). */
export const transcriptOutcomeSchema = z.enum(TRANSCRIPT_OUTCOMES);

/** The family a tool belongs to (`TOOL_FAMILIES` in `@oxagen/tacho`). */
export const toolFamilySchema = z.enum(TOOL_FAMILIES);

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
      /**
       * The `key` of the tool step that recorded this call, so a reader draws
       * the call once, as that step: by call key, or, where either side kept
       * none, the next tool step of the same name on the reply's chain and in
       * its turn, before that chain's next model call. Null for a call no
       * tool step recorded.
       */
      stepKey: z.string().nullable().optional(),
      /**
       * What came back for this call, from a `tool_result` block for the same
       * call key on the page. Null when the page holds none.
       */
      result: z
        .object({ ok: z.boolean(), summary: z.string() })
        .strict()
        .nullable()
        .optional(),
      /**
       * The family the called tool belongs to, read from `name` by the same
       * rule as an entry's `family`, so a reader never keeps a family table
       * of its own.
       */
      family: toolFamilySchema.optional(),
      /**
       * `name` as the harness knows the tool: without the prefix a gateway
       * adds (`claude_code__Bash` is `Bash`) or a trailing `@version`. The
       * server applies the one rule, so a reader keeps no prefix list.
       */
      tool: z.string().optional(),
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
    /**
     * Whether `source` is the agent's harness checking itself rather than
     * Oxagen policy or an operator deciding. False when the source is
     * unrecorded. A reader sorts decisions on this and never on its own list
     * of source words (ADR-182).
     */
    harness: z.boolean(),
    /** RFC 3339. */
    at: z.string().datetime(),
  })
  .strict();

/**
 * What a recall frame put in front of the model, read on the server from the
 * body it kept: a steering manifest's items (ADR-093) or a context frame's
 * frames, each with its outcome, or else the frame count the ledger
 * recorded. No reader parses the body again (ADR-182).
 */
export const transcriptRecallSchema = z
  .object({
    /** What `count` counts: context frames, or the items a manifest included. */
    unit: z.enum(["frames", "items"]),
    count: z.number().int().nonnegative().nullable(),
    tokens: z.number().int().nonnegative().nullable(),
    /** Items the manifest listed and cut; null when it recorded none. */
    cut: z.number().int().nonnegative().nullable(),
    /**
     * Every item listed, included and cut, in the order listed, at most
     * 2,000. A listing that records no outcome put every item in front of
     * the model.
     */
    items: z
      .array(
        z
          .object({
            kind: z.string(),
            label: z.string(),
            tokens: z.number().int().nonnegative().nullable(),
            /** Whether the item reached the model; any recorded outcome but `included` is a cut. */
            outcome: z.enum(["included", "cut"]),
            /** The reason recorded for a cut; null when none was. */
            reason: z.string().nullable(),
            /** The item that replaced a cut one; null when none was recorded. */
            supersededBy: z.string().nullable(),
            /** The force the item carried (`must`, `should`, `may`, `info`); null when not recorded. */
            force: z.string().nullable(),
          })
          .strict(),
      )
      .max(2_000),
    /** The policy bundle a manifest was assembled on; null when it names none. */
    bundleVersion: z.number().int().nonnegative().nullable(),
    /**
     * What the server made of the body: `listed` when it read a list from
     * it, `unretained` when the frame kept none, `unreadable` when the kept
     * body could not be read or no longer hashes to its digest, `unlisted`
     * when it lists nothing or is too large to be a listing.
     */
    body: z.enum(["listed", "unretained", "unreadable", "unlisted"]),
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
         * call's `tool_use_id`). Null when none was recorded. A client nests
         * the entry by `parentKey`, which the server resolves from this.
         */
        spawnCallId: z.string().nullable().optional(),
        /**
         * The chain that spawned this one: the run's own session for a
         * subagent the run spawned, or another subagent's. Null when none
         * was recorded.
         */
        parentSessionUuid: z.string().uuid().nullable().optional(),
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
     * none. A client reads steps at the `steps` zoom rather than pairing
     * `everything` entries on this value (ADR-182).
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
    // What the fold states about the entry (ADR-182). Each is optional so an
    // older answer still parses; the handler always sends them. A reader
    // presents these and derives none of them from the frames.
    /**
     * The entry's name within the run: its opening frame's `seq` on the
     * run's own chain, `<sessionUuid>:<seq>` on a subagent's. Stable across
     * reads, so a reader keys and merges entries on it.
     */
    key: z.string().min(1).optional(),
    /**
     * The `key` of the entry that spawned this subagent entry: the Task or
     * Agent call its chain names, or else the latest entry on the parent
     * chain that recorded a `subagent_start`. Null on the run's own chain.
     */
    parentKey: z.string().nullable().optional(),
    /** What kind of row the entry is; null for a turn, which is a group. */
    node: transcriptNodeSchema.nullable().optional(),
    /**
     * True when the entry has nothing to show a reader beyond its frames: a
     * prompt or reply with no words to show, a reply that repeats words the
     * reader was just shown (`echoOf`), or an event with no decision and no
     * failure. `counts` counts no quiet entry.
     */
    quiet: z.boolean().optional(),
    /**
     * How the entry's call ended; null for an entry that records no call. At
     * `everything`, a call's request frame cannot say how the call ended, so
     * its entry's outcome is null too.
     */
    outcome: transcriptOutcomeSchema.nullable().optional(),
    /** The approval a parked call waits on (`apr_…`); null otherwise. */
    approvalId: z.string().nullable().optional(),
    /**
     * Every decision folded into the entry, in the order recorded. `decision`
     * is the last of them.
     */
    gates: z.array(transcriptDecisionSchema).optional(),
    /** The tool the entry is about, as the record names it; null when none. */
    subject: z.string().nullable().optional(),
    /**
     * `subject` as the harness knows the tool: without the prefix a gateway
     * adds (`claude_code__Bash` is `Bash`) or a trailing `@version`. Null
     * when `subject` is. The server applies the one rule, so a reader keeps
     * no prefix list.
     */
    tool: z.string().nullable().optional(),
    /** The family of the entry's tool; null for an entry that is no tool call. */
    family: toolFamilySchema.nullable().optional(),
    /** `provider/model` of a model call; null elsewhere. */
    model: z.string().nullable().optional(),
    /**
     * First frame to last, in milliseconds. Null for a one-frame entry, and
     * for a call that has no result yet.
     */
    durationMs: z.number().int().nonnegative().nullable().optional(),
    /**
     * The `key` of an earlier entry in the same turn whose words this reply
     * says again, ignoring surrounding whitespace: on the run's own chain, the
     * operator's prompt; on any chain, the model step or reply said last
     * before it, such as a turn's closing message that repeats the model's
     * last text block. The words are compared, not the digests. Null
     * otherwise. An entry that repeats another is `quiet`.
     */
    echoOf: z.string().nullable().optional(),
    /** What a recall entry put in front of the model; null on other entries. */
    recall: transcriptRecallSchema.nullable().optional(),
    /**
     * Where the read's `query` was found in this entry, so a reader opens
     * the part that matched. Absent on a read with no query.
     */
    matches: z
      .array(transcriptMatchSchema)
      .min(1)
      .max(TRANSCRIPT_MATCHES.length)
      .optional(),
  })
  .strict();

const entryCount = z.number().int().nonnegative();

/**
 * One count for every chip. The server counts each chip on every read, so
 * none is optional: a reader never has to guess a missing count as zero.
 */
const transcriptKindCountsSchema = z
  .object(
    Object.fromEntries(
      TRANSCRIPT_KINDS.map((kind) => [kind, entryCount]),
    ) as Record<(typeof TRANSCRIPT_KINDS)[number], typeof entryCount>,
  )
  .strict();

/**
 * What the whole run holds at the zoom read, counted over every entry that is
 * not `quiet`, whatever the chips pressed, so a chip's count and the entries
 * the page draws under it agree. The unit is the entry: a model step that
 * said two things counts once.
 */
export const transcriptCountsSchema = z
  .object({
    /** Entries per chip; an entry that answers two chips counts under both. */
    kinds: transcriptKindCountsSchema,
    /** Entries that have something to show (`quiet` false). */
    entries: z.number().int().nonnegative(),
    /** Entries that failed or were refused, or that answer the errors chip. */
    errors: z.number().int().nonnegative(),
    /** Decisions a rule or a person made; the harness checking itself is not one. */
    policy: z.number().int().nonnegative(),
    /**
     * The same counts at `everything`, where each frame is its own entry,
     * for the chips and figures a reader lists frames by: `kinds.policy` and
     * `kinds.recall` count the frames those chips keep, and `policy` the
     * decisions among them a rule or a person made. They are carried at
     * every zoom, so a reader that reads `steps` does not read `everything`
     * again for them.
     */
    frames: z
      .object({
        kinds: z
          .object({
            policy: z.number().int().nonnegative(),
            recall: z.number().int().nonnegative(),
          })
          .strict(),
        policy: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
  })
  .strict();

const count = z.number().int().nonnegative();
const ms = z.number().int().nonnegative();

/** One tool family's share of the run's tool calls. */
export const transcriptFamilyFigureSchema = z
  .object({
    family: toolFamilySchema,
    calls: count,
    /** The family's calls over every tool call in the run, 0 to 1. */
    share: z.number().min(0).max(1),
    /** The calls' own time summed, in milliseconds. */
    ms,
    failed: count,
    /** Distinct tool names in the family. */
    tools: count,
  })
  .strict();

/**
 * The tool calls between two model steps, which one model reply asked for
 * at once. A turn boundary closes a batch too.
 */
export const transcriptBatchFiguresSchema = z
  .object({
    count,
    /** Batches that ran more than one call. */
    parallel: count,
    /** The most calls one batch held. */
    widest: count,
    /** Calls per batch. */
    fanOut: z.number().nonnegative(),
    /** Every call's own time summed: what one at a time would have taken. */
    serialMs: ms,
    /** Each batch's first start to its last end, summed: what it did take. */
    togetherMs: ms,
    /** How many batches held each number of calls, fewest calls first. */
    histogram: z.array(
      z.object({ width: z.number().int().positive(), batches: count }).strict(),
    ),
  })
  .strict();

/**
 * The run's figures, counted on the server over the `steps` fold of every
 * frame read, whatever the zoom, chips or query (ADR-182). A call's own time
 * leaves out the approval waits inside it, and a call with no result adds
 * none.
 *
 * The run's wall clock is not here: it runs to the run's end, or on a live
 * run to the instant it is read, which only the reader knows. What the parts
 * below leave of it is the harness's.
 */
export const transcriptFiguresSchema = z
  .object({
    steps: z.object({ model: count, tool: count }).strict(),
    /** The times the operator prompted the run, the first prompt included. */
    prompts: count,
    calls: z
      .object({
        count,
        /** Calls that failed, or that a rule, a person or the harness refused. */
        failed: count,
        /**
         * Calls per tool, by the tool's name without a gateway's harness
         * prefix, most called first. `name` is null for calls whose record
         * named no tool.
         */
        tools: z.array(
          z.object({ name: z.string().nullable(), calls: count }).strict(),
        ),
        /** Most called first. */
        families: z.array(transcriptFamilyFigureSchema),
        /** Null for a run that called no tool. */
        batches: transcriptBatchFiguresSchema.nullable(),
      })
      .strict(),
    /** Where the recorded time went, in milliseconds. */
    wall: z
      .object({
        /** Model steps, first frame to last. */
        modelMs: ms,
        /** Tool calls' own time, less the approval waits inside them. */
        toolMs: ms,
        /** From each approval request to the frame after it. */
        waitingMs: ms,
      })
      .strict(),
  })
  .strict();

/** What a read's `query` found, over the whole run and not only the page. */
export const transcriptSearchSchema = z
  .object({
    /** The query as searched: trimmed and lowercased. */
    query: z.string(),
    /**
     * Entries that matched, after the chips; the page holds up to `limit` of
     * them. A read from a cursor searches only the entries it and the pages
     * after it can still send (those past the cursor, and those before it
     * that grew), so it counts those: the whole run on a first page.
     */
    matched: count,
    /**
     * Halves that carried content the search could not look inside: kept as
     * a digest only, unreadable, or past `TRANSCRIPT_SEARCH_HALF_MAX`. An
     * entry whose only match would have been in one of them is not in
     * `matched`. The halves of an entry that matched on its label, subject
     * or target are not needed and are not counted. Counted over the same
     * entries as `matched`.
     */
    unsearched: count,
  })
  .strict();

export const runTranscriptGet = registerCapability({
  name: "get_run_transcript",
  domain: "run",
  description:
    "Read one run as a transcript at a zoom level (turns, steps or everything), derived on the server from its frames and retained bodies: each step one entry carrying the request and the result it was made with, the decision folded into it, and its own and the run's cumulative cost. A read can search the entries, and carries the run's counts and figures.",
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
      /** How much of each body to carry; omitted takes the zoom's cap. */
      text: transcriptTextSchema.optional(),
      /**
       * Words to search the entries for, ignoring case; omitted reads every
       * entry. Surrounding space is trimmed, and a query of nothing but
       * space is refused.
       */
      query: z.string().trim().min(1).max(TRANSCRIPT_QUERY_MAX).optional(),
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
      /** The run's entries counted at this zoom, whatever the chips. */
      counts: transcriptCountsSchema.optional(),
      /** The run's figures, whatever the zoom, chips or query. */
      figures: transcriptFiguresSchema.optional(),
      /** What the query found; absent on a read with no query. */
      search: transcriptSearchSchema.optional(),
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
export type TranscriptText = z.output<typeof transcriptTextSchema>;
export type TranscriptRecallView = z.output<typeof transcriptRecallSchema>;
export type TranscriptCountsView = z.output<typeof transcriptCountsSchema>;
export type TranscriptFiguresView = z.output<typeof transcriptFiguresSchema>;
export type TranscriptSearchView = z.output<typeof transcriptSearchSchema>;
export type TranscriptMatch = z.output<typeof transcriptMatchSchema>;
