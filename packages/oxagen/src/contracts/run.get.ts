/**
 * `get_run`: the Run page's header and one page of its frames
 * (apps/app/ARCHITECTURE.md §1.2, §3.5, WL-18).
 *
 * The header is the same row `list_runs` returns. Frames exist for ledger runs
 * only: they are the run's V2 events, read newest-last from the run's own
 * `run_seq` behind an opaque cursor this capability owns. A wrapped (tacho)
 * run answers `frames: null` — its events live in ClickHouse `tacho_events`,
 * which has no read seam yet — and the page renders that one slice as not
 * recorded (§3.6 `run.frames_wrapped`).
 *
 * The cursor is the SSE resume point (§3.5): each frame carries its own, the
 * page carries the cursor to continue from, and a read that starts at either
 * repeats nothing and skips nothing. `waitMs` is the handler-side long poll:
 * the handler waits inside the tenant scope for up to that long for an event
 * past the cursor, so an idle stream costs one invoke per `waitMs` rather
 * than one per client tick. The poll is inside the handler, after the gates,
 * so IAM and the audit emissions happen once per invoke whatever `waitMs` is.
 *
 * `noBillingGate: true`: an SSE poll is not a governed action (§1.5).
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { runItemSchema, runPublicIdSchema } from "./run.list";

/** The most frames one read returns; the default fits one SSE batch. */
export const FRAME_LIMIT_MAX = 500;
export const FRAME_LIMIT_DEFAULT = 200;
/** The longest a read may wait for an event past its cursor. */
export const WAIT_MS_MAX = 20_000;

export const runFrameSchema = z
  .object({
    /** Opaque resume point: pass as `framesAfter` to read what follows. */
    cursor: z.string(),
    /** The ledger's run-global sequence, as a decimal string. */
    seq: z.string().regex(/^\d+$/),
    /** The recorded event type, e.g. `model.call_completed`. */
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
  })
  .strict();

export const runFramePageSchema = z
  .object({
    frames: z.array(runFrameSchema).max(FRAME_LIMIT_MAX),
    /**
     * The point to continue from: past every event this read consumed, mapped
     * or not. Null when nothing lay past `framesAfter`, so the caller keeps
     * its cursor.
     */
    cursor: z.string().nullable(),
  })
  .strict();

export const runGet = registerCapability({
  name: "get_run",
  domain: "run",
  description:
    "Read one run's header and, for an evidence-ledger run, one page of its frames from an opaque cursor, optionally waiting for a new frame; a wrapped-agent run answers its header with frames: null.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
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
      frames: runFramePageSchema.nullable(),
    })
    .strict(),
});

export type RunGetInput = z.output<typeof runGet.input>;
export type RunGetOutput = z.output<typeof runGet.output>;
export type RunFrame = z.output<typeof runFrameSchema>;
