/**
 * `get_run`: the Run page's header and one page of its frames
 * (apps/app/ARCHITECTURE.md §1.2, §3.5, WL-18).
 *
 * The header is the same row `list_runs` returns. Frames are the run's V2
 * events for a ledger run, read from the run's own `run_seq`, and the
 * session's hash-chained events in ClickHouse `tacho_events` for a wrapped
 * run, read from its dense `seq`; both sit behind an opaque cursor this
 * capability owns.
 *
 * The cursor is the SSE resume point (§3.5): each frame carries its own, the
 * page carries the cursor to continue from, and a read that starts at either
 * repeats nothing and skips nothing. `waitMs` is the handler-side long poll:
 * the handler waits inside the tenant scope for up to that long for an event
 * past the cursor, so an idle stream costs one invoke per `waitMs` rather
 * than one per client tick. The poll is inside the handler, after the gates,
 * so IAM and the audit emissions happen once per invoke whatever `waitMs` is.
 *
 * A wrapped run's subagents record on chains of their own, each numbered from
 * 0 (#3823). A read pages the run's own chain unless `sessionUuid` names a
 * subagent chain, and a frame from a subagent chain carries its
 * `sessionUuid`, so `seq` names a frame only together with it. `chains` lists
 * each subagent chain's head, so a reader following the run learns that a
 * subagent recorded more even when the run's own chain did not move.
 *
 * Frames carry their body reference (spec §8.2 `content`): the digest of the
 * redacted bytes, where they were retained, what was redacted, and the
 * fidelity the recorder kept. Bodies are never inline; `get_run_frame_body`
 * reads them on demand (§3.5). Each frame's cost record, when the frame
 * carried one, is what a transport prefix-sums into cumulative cost (§8.4).
 *
 * `noBillingGate: true`: an SSE poll is not a governed action (§1.5).
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { runCostSchema, runItemSchema, runPublicIdSchema } from "./run.list";

/** The most frames one read returns; the default fits one SSE batch. */
export const FRAME_LIMIT_MAX = 500;
export const FRAME_LIMIT_DEFAULT = 200;
/** The longest a read may wait for an event past its cursor. */
export const WAIT_MS_MAX = 20_000;
/** The most subagent chains one read lists in `chains.heads`. */
export const RUN_CHAIN_HEADS_MAX = 200;

export const frameFidelitySchema = z.enum(["full", "digest_only"]);

/**
 * One removal made before the body was written (§13.5): by the platform's
 * detectors for a ledger frame, by the host's for a wrapped one, so `reason`
 * is the redactor's own word.
 */
export const frameRedactionSchema = z
  .object({
    /** The span removed, e.g. `bytes:12-60` in the original bytes. */
    path: z.string(),
    reason: z.string().min(1),
    /** sha256 of the bytes removed, so an auditor can prove what was cut. */
    originalDigest: z.string(),
  })
  .strict();

export const frameBodySchema = z
  .object({
    /** sha256 over the redacted bytes; null when the frame carried no content. */
    digest: z.string().nullable(),
    /** Where the bytes were retained; null under `digest_only`. */
    bytesRef: z.string().nullable(),
    redactions: z.array(frameRedactionSchema),
    fidelity: frameFidelitySchema,
  })
  .strict();

export const runFrameSchema = z
  .object({
    /** Opaque resume point: pass as `framesAfter` to read what follows. */
    cursor: z.string(),
    /**
     * The frame's position: the ledger's run-global `run_seq`, or a wrapped
     * session's dense `seq`, as a decimal string.
     */
    seq: z.string().regex(/^\d+$/),
    /**
     * The subagent chain the frame was recorded on; absent on the run's own
     * chain. A subagent chain numbers its frames from 0, so `seq` names a
     * frame only together with this.
     */
    sessionUuid: z.string().uuid().optional(),
    /** The recorded event type or kind, e.g. `model.call_completed`, `tool_call`. */
    type: z.string(),
    /** The evidence stage the event belongs to. */
    stage: z.string(),
    /** RFC 3339, as the producer observed it. */
    observedAt: z.string().datetime(),
    /** The event's own digest. */
    digest: z.string(),
    /**
     * A short label built from identifiers in the event's inline receipt
     * (engine, model, capability, outcome); the event type when the payload
     * carries none, or is encrypted.
     */
    summary: z.string(),
    /**
     * The tool the frame is about, as its producer named it: the ledger's
     * `capability_name` or `tool_name`, a wrapped frame's tool. Null when the
     * frame names none. `summary` may show it too, but a client reads it here
     * and never parses the label for it (ADR-182 rule 3).
     *
     * This field and the two after it arrived with #4307. Each defaults to
     * null, so a frame recorded before then still parses and reads as naming
     * no tool.
     */
    tool: z.string().nullable().default(null),
    /**
     * How the tool call ended, as its producer recorded it: the ledger's
     * receipt outcome (`completed`, `failed`, `denied`, `cancelled`,
     * `parked`) or a wrapped frame's tool status. Null on a frame that
     * records none, an intention included.
     */
    toolStatus: z.string().nullable().default(null),
    /**
     * The approval a parked tool call waits on (`apr_…`), as the receipt
     * recorded it. Null on every other frame, and on a parked receipt that
     * named no approval.
     */
    approvalId: z.string().nullable().default(null),
    body: frameBodySchema,
    /** The frame's own cost record; null when it carried none. */
    cost: runCostSchema.nullable(),
  })
  .strict();

export const runFramePageSchema = z
  .object({
    frames: z.array(runFrameSchema).max(FRAME_LIMIT_MAX),
    /**
     * The point to continue from: past every event this read consumed, mapped
     * or not. Null when nothing lay past `framesAfter`, so the caller keeps
     * its cursor, and null on a sealed run whose page had nothing behind it,
     * since nothing will ever lie past that page. A live run keeps its cursor
     * on every non-empty page, because the next frame may still arrive.
     */
    cursor: z.string().nullable(),
  })
  .strict();

/** One subagent chain's head: its place in the run and its last readable frame. */
export const runChainHeadSchema = z
  .object({
    sessionUuid: z.string().uuid(),
    /** The chain that spawned this one; null when none was recorded. */
    parentSessionUuid: z.string().uuid().nullable(),
    /** The harness's id for the subagent; null when none was recorded. */
    subagentId: z.string().nullable(),
    /** The subagent's type (`Explore`, `general-purpose`); null when none was recorded. */
    subagentType: z.string().nullable(),
    /** The parent's tool call that spawned the subagent; null when none was recorded. */
    spawnCallId: z.string().nullable(),
    /**
     * The chain's last frame a read can return, as a decimal string, read
     * from the frame store. Null when the chain holds no readable frame yet.
     */
    lastSeq: z.string().regex(/^\d+$/).nullable(),
    /** Frames the chain holds. */
    frameCount: z.number().int().nonnegative(),
  })
  .strict();

/**
 * Every subagent chain under a wrapped run, with its head. Absent on a
 * ledger run, which records one chain.
 */
export const runChainsSchema = z
  .object({
    /**
     * Opaque: pass as `chainsAfter` so a long poll also wakes when any
     * subagent chain moves past these heads.
     */
    cursor: z.string(),
    heads: z.array(runChainHeadSchema).max(RUN_CHAIN_HEADS_MAX),
    /** False when the run has more subagent chains than `heads` lists. */
    complete: z.boolean(),
  })
  .strict();

/** Why a read answered the run header without its frames. */
export const runFramesErrorSchema = z
  .object({
    code: z.literal("frames_unavailable"),
    message: z.string(),
  })
  .strict();

export const runGet = registerCapability({
  name: "get_run",
  domain: "run",
  description:
    "Read one run's header and one page of its frames, each with its body reference, from an opaque cursor, optionally waiting for a new frame. A wrapped run's read pages one chain, its own or a subagent's, and lists the head of every subagent chain.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent", "cli"],
  layers: ["schema", "api", "mcp", "cli", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  agent: { requiresApproval: false, riskLevel: "low", category: "run" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Member: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z
    .object({
      runId: runPublicIdSchema,
      /**
       * A frame or page cursor from an earlier read; omitted reads from the
       * start. A cursor minted on another chain than the one read is refused
       * as an invalid cursor.
       */
      framesAfter: z.string().max(256).optional(),
      /**
       * The subagent chain to page, from a frame's, a head's or a transcript
       * entry's `sessionUuid`. Omitted, or the run's own session, pages the
       * run's own chain. A chain that is not under this run answers
       * `not_found`, and so does any chain on a ledger run.
       */
      sessionUuid: z.string().uuid().optional(),
      /**
       * `chains.cursor` from an earlier read. With `waitMs` set, the long poll
       * also returns once any subagent chain holds a readable frame past the
       * heads that cursor named.
       */
      chainsAfter: z.string().max(64).optional(),
      frameLimit: z
        .number()
        .int()
        .min(1)
        .max(FRAME_LIMIT_MAX)
        .default(FRAME_LIMIT_DEFAULT),
      /** Long-poll budget: wait up to this long for an event past the cursor. */
      waitMs: z.number().int().min(0).max(WAIT_MS_MAX).default(0),
    })
    .strict(),
  output: z
    .object({
      run: runItemSchema,
      frames: runFramePageSchema,
      /**
       * The worker run this run witnessed (spec §8.5 "Stamping"; ADR-064): a
       * witness run renders its own tab set. Null for every other run.
       */
      witnessFor: runPublicIdSchema.nullable(),
      /**
       * Set when the frame store refused the read, so `frames` is empty
       * whatever the run recorded. The header still answers. Absent when the
       * frames were read (#4243).
       */
      framesError: runFramesErrorSchema.optional(),
      /** Every subagent chain's head (#3823); absent on a ledger run. */
      chains: runChainsSchema.optional(),
    })
    .strict(),
});

export type RunGetInput = z.output<typeof runGet.input>;
export type RunGetOutput = z.output<typeof runGet.output>;
export type RunFrame = z.output<typeof runFrameSchema>;
export type RunChainHead = z.output<typeof runChainHeadSchema>;
export type RunChains = z.output<typeof runChainsSchema>;
