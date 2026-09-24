/**
 * `get_run_turns`: one run's per-turn ledger, over every frame it recorded
 * (Mission Control spec §12.9, the run waterfall; #4067).
 *
 * The Cost tab draws one bar per turn at the turn's cost, the cost so far as a
 * line across them, and a table of each turn's steps, frames and cache hit.
 * It used to build those rows by reading the whole transcript page by page and
 * adding them up in the app: 34 reads for a 25,000-frame run and 68 for a
 * 250,000-frame one, and the transcript stops folding at 10,000 frames, so a
 * longer run drew only its first turns. This read answers the rows directly.
 * A wrapped run's rows come from one grouped query over its frames, so the
 * number of reads does not grow with the run.
 *
 * What each row counts:
 *
 * - `turn` is numbered the way the transcript numbers it (`turn` on its
 *   entries): the run's own `turn_start` frames counted from 1, or, for a
 *   recording with none, a new turn wherever the recorded turn index changes.
 *   A subagent's frames count toward the turn its parent spawned it in. The
 *   frames recorded before the first turn are in no row.
 * - `frames` is every frame recorded in the turn, on every chain.
 * - `modelSteps` is the model calls made in the turn, each counted once
 *   however many sources reported it: a later sighting of a call, and the
 *   further content blocks of one transcript message, add none.
 * - `toolSteps` is the tool calls made in the turn: one per call id on each
 *   chain, however many frames record the call.
 * - `cost` is the turn's cost records summed, counted by the rule the
 *   transcript's `cost` uses: a later sighting of a model call carries none,
 *   and once the proxy observes a chain's model calls, the harness's own
 *   report of a later call on that chain carries none. `cumulativeCost` is
 *   every cost record of the run through the end of the turn. Both are null
 *   where no frame carried a cost record.
 * - `tokens` is the input the turn's model calls reported, uncached and read
 *   from the cache, for the turn's cache hit. A class no call reported is null.
 *
 * A live run answers the turns recorded so far. `complete` is false only when
 * the run has more turns than one answer carries.
 *
 * `noBillingGate: true`: reading a recording is a console read (§1.5).
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { runCostSchema, runPublicIdSchema } from "./run.list";

/** The most turns one answer carries. */
export const RUN_TURNS_MAX = 10_000;

const tokenCountSchema = z.number().int().nonnegative();

export const runTurnSchema = z
  .object({
    /** 1-based, the same number the transcript's entries carry. */
    turn: z.number().int().positive(),
    /** The frame the turn opens on, on the run's own chain. */
    seq: z.string().regex(/^\d{1,19}$/),
    /** RFC 3339: when that frame was recorded. */
    at: z.string().datetime(),
    frames: z.number().int().nonnegative(),
    modelSteps: z.number().int().nonnegative(),
    toolSteps: z.number().int().nonnegative(),
    /** The turn's cost records summed; null when none of its frames carried one. */
    cost: runCostSchema.nullable(),
    /** Every cost record of the run through this turn; null before the first. */
    cumulativeCost: runCostSchema.nullable(),
    tokens: z
      .object({
        /** Null when no model call in the turn reported it. */
        inputUncached: tokenCountSchema.nullable(),
        cacheRead: tokenCountSchema.nullable(),
      })
      .strict(),
  })
  .strict();

export const runTurnsGet = registerCapability({
  name: "get_run_turns",
  domain: "run",
  description:
    "Read one run's per-turn ledger over every frame it recorded: each turn's model and tool steps, frames, cost and the cost so far, and the input tokens its model calls reported, uncached and read from the cache. A subagent's frames count toward the turn that spawned it.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli"],
  layers: ["schema", "api", "mcp", "cli", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Billing: "allow", Member: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({ runId: runPublicIdSchema }).strict(),
  output: z
    .object({
      runId: runPublicIdSchema,
      turns: z.array(runTurnSchema).max(RUN_TURNS_MAX),
      /**
       * False when the run has more than `RUN_TURNS_MAX` turns and `turns`
       * holds the first of them. The caller says the list stops short rather
       * than presenting it as the whole run.
       */
      complete: z.boolean(),
    })
    .strict(),
});

export type RunTurnsGetInput = z.output<typeof runTurnsGet.input>;
export type RunTurnsGetOutput = z.output<typeof runTurnsGet.output>;
export type RunTurn = z.output<typeof runTurnSchema>;
