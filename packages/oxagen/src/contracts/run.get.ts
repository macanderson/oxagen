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
    "Read one run's header and one page of its frames, each with its body reference, from an opaque cursor, optionally waiting for a new frame.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
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
      /** A frame or page cursor from an earlier read; omitted reads from the start. */
      framesAfter: z.string().max(256).optional(),
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
    })
    .strict(),
});

export type RunGetInput = z.output<typeof runGet.input>;
export type RunGetOutput = z.output<typeof runGet.output>;
export type RunFrame = z.output<typeof runFrameSchema>;
