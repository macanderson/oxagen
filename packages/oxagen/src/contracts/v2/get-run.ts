import { z } from "zod";
import { defineTool } from "./_define";
import { tachoSessionGet } from "../tacho.session.get";
import { agentTraceGet } from "../agent.trace.get";
import { replayGradeSchema, verdictSchema } from "./list-runs";

/**
 * Appendix E: `get_run` — "run with turns, steps, frames, receipts, cost".
 * Absorbs `get_tacho_session`, `get_execution_trace` and
 * `get_message_execution`. Backs §14's Run page.
 *
 * **`get_message_execution` is a write, and none of it carries.** Its name says
 * `get_`; its description says "Record an agent execution that originated from
 * a chat message". It is `record_execution` with a message id bolted on, and it
 * dies for the same reason (§8.1: "Turns and steps are not rows of their own.
 * They are derived from frames"). Its one distinctive field, the message link,
 * is a run's task reference in the target model, set at run start rather than
 * asserted afterwards. Its whole input is in `drops` — this is the case rule 4
 * warns about, read from the source rather than guessed from the name.
 *
 * **Two read shapes, joined rather than merged.** `get_tacho_session` returns
 * the flight-recorder *index* of a run: totals, chain hashes, completeness
 * gaps, per-model usage, files, commands, incidents. `get_execution_trace`
 * returns the run as a recursive tree of steps and tool calls. Neither is a
 * subset of the other and both are needed by the same page, so both carry — the
 * index by field, the tree whole (it is a `z.lazy` self-reference, and picking
 * fields off it would break the recursion).
 *
 * **Vocabulary.** §3 bans *session*, *execution*, *trace* as a noun for a run,
 * and *span*. The carried schemas keep their internal field names (renaming
 * inside an imported schema means retyping it), but the keys this tool
 * introduces do not: `session` becomes `run` and the span tree becomes `tree`.
 *
 * **Why frames are not in this payload.** The `Does` column says "frames", and
 * the run's chain state is here — `seqCount`, `genesisHash`, `lastHash`,
 * `chainVerified`, `completenessGaps`, `checkpointCount`. The frames
 * themselves are not: §8.4's transport seeks by dense `seq`, so the player
 * reads a window at a position rather than loading a run that may hold a
 * hundred thousand frames. A bounded frame read is its own call.
 */
export const getRun = defineTool({
  name: "get_run",
  domain: "control",
  description:
    "Read one run: its totals and chain status, its tree of turns, steps and tool calls, its subagent chains, per-model cost, files, commands, incidents, and the receipts for its tool calls.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,
  noBillingGate: true,

  absorbs: [
    "get_tacho_session",
    "get_execution_trace",
    "get_message_execution",
  ],
  renames: [
    {
      from: "sessionUuid",
      source: "get_tacho_session",
      to: "runId",
      why: "§3's locked vocabulary — *session* is only the harness's synonym for a run. Carried by reference from `tachoSessionGet.input.shape.sessionUuid`, so the uuid bound travels with the name, and it is the same key `list_runs` returns on every row.",
    },
  ],
  drops: [
    {
      field: "executionId",
      from: "get_execution_trace",
      why: "not a rename of `sessionUuid` but a second identifier for the same subject: an `aex_` public id names an execution row, and §8.1 retires execution rows in favour of runs derived from frames. The run is addressed by its uuid instead, so this id has nothing left to point at.",
    },

    // ── get_message_execution: a write wearing a read's name. ──────────────
    {
      field: "messageId",
      from: "get_message_execution",
      why: "the chat message a run came from is its task reference (§8.1), fixed at run start; §14.1 makes each assistant turn a run of its own, so the link is established by `ask_assistant`, not by a later write",
    },
    {
      field: "updateMessageMetadata",
      from: "get_message_execution",
      why: "follows messageId — there is no separate message row to stamp once the link lives on the run",
    },
    {
      field: "agentId",
      from: "get_message_execution",
      why: "run identity is built by server code from the run token (§8.1), never asserted in a request body",
    },
    {
      field: "agentVersionId",
      from: "get_message_execution",
      why: "the agent version digest is part of that same run identity (§8.1)",
    },
    {
      field: "originType",
      from: "get_message_execution",
      why: "origin belongs to the run and is fixed at its first frame (§8.2)",
    },
    {
      field: "originId",
      from: "get_message_execution",
      why: "follows originType — superseded by the run's task reference",
    },
    {
      field: "status",
      from: "get_message_execution",
      why: "a run's outcome is derived from its terminal frame and fixed at seal (§8.3), never submitted",
    },
    {
      field: "inputPayload",
      from: "get_message_execution",
      why: "bodies are content-addressed blobs on frames (§8.2) so redaction runs before the bytes are written",
    },
    {
      field: "outputPayload",
      from: "get_message_execution",
      why: "same as inputPayload — §8.2",
    },
    {
      field: "failureReason",
      from: "get_message_execution",
      why: "carried by the `error` frame kind (§8.2), which is chained and therefore attributable",
    },
    {
      field: "startedAt",
      from: "get_message_execution",
      why: "derived from frame timestamps (§8.2); an asserted start time can disagree with the chain",
    },
    {
      field: "completedAt",
      from: "get_message_execution",
      why: "same as startedAt — §8.2",
    },
    {
      field: "latencyMs",
      from: "get_message_execution",
      why: "derived in the rollups (§12.7); `durationMs` on the carried run header is that derivation",
    },
    {
      field: "inputTokens",
      from: "get_message_execution",
      why: "§12.6 accounts tokens per model call; the carried `models` array is the per-model breakdown that replaces it",
    },
    {
      field: "outputTokens",
      from: "get_message_execution",
      why: "same as inputTokens — carried as `models[].outputTokens`",
    },
    {
      field: "estimatedCostUsd",
      from: "get_message_execution",
      why: "§12.3 requires integer micro-USD with a cost basis; carried as `models[].costMicros` and the run's `totalCostMicros`",
    },
    {
      field: "steps",
      from: "get_message_execution",
      why: "§8.1: steps are derived from frames, not written. The read side of the same shape is the carried `tree`.",
    },
    {
      field: "output { executionId, status, createdAt }",
      from: "get_message_execution",
      why: "the acknowledgement of a row this tool no longer creates",
    },
  ],

  // `get_execution_trace` says low, `get_tacho_session` says medium. Medium
  // carries: the run header includes `envSnapshot`, `anthropicUserEmail`,
  // `projectDir` and the command list — the shape of a person's machine.
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "introspection",
  },
  sensitivity: "medium",
  // `get_message_execution` declares `allow`; `deny` from the other two
  // carries. Default-deny is the secure baseline and a run holds prompt bodies.
  defaultEffect: "deny",
  // Same split as `list_runs`: the stricter org set from `get_execution_trace`
  // (no org `Member`), the workspace grants from it too, because §14 puts the
  // Run page at workspace scope and `get_tacho_session`'s empty workspace map
  // reflects tacho's org-only API rather than a policy.
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  /**
   * Read-only. Confirmed against `packages/handlers/src/tacho.session.get.ts`
   * and `packages/agent/src/handlers/agent.trace.get.ts` — selects only, and
   * the one helper either imports (`sessionSummary` from the list handler) is
   * a projection. The third source writes, but every field of it is dropped, so
   * nothing that writes survives into this tool.
   */
  mutates: false,

  input: z.object({
    /**
     * Carried from `get_tacho_session`'s `sessionUuid` under §3's vocabulary.
     * The uuid bound carries with it — this is the same key `list_runs` returns
     * on every row.
     */
    runId: tachoSessionGet.input.shape.sessionUuid,

    /**
     * New (§8.1). Attempts are immutable and a resume or a fork creates a new
     * one linked to the prior. Omitted reads the latest attempt, which is what
     * a reader opening a run means. §3 keeps *attempt* internal, so the
     * interface says "resumed" — the id is still how a fork is addressed.
     */
    attemptId: z.string().min(1).optional(),
  }),

  output: z.object({
    /**
     * The flight-recorder header, carried whole from `get_tacho_session` and
     * renamed off *session*. Two fields are tightened: the source types
     * `replayGrade` as a bare nullable string, which cannot hold §8.4's closed,
     * ordered vocabulary, and has no verdict at all.
     */
    run: tachoSessionGet.output.shape.session.extend({
      replayGrade: replayGradeSchema,
      verdict: verdictSchema,
    }),

    /**
     * The run as a tree of turns, steps and tool calls, carried whole from
     * `get_execution_trace`. Whole rather than by field because it is a
     * `z.lazy` self-reference: each node carries its own steps and its child
     * runs (subagent fan-out and A2A lineage), and `turnMetrics` plus
     * `replayDeterministic` are populated only on the root.
     */
    tree: agentTraceGet.output,

    /** Subagent chains as summaries, for the chain rail beside the tree. */
    children: tachoSessionGet.output.shape.children,

    /**
     * Per-model usage: requests, the four token classes, and `costMicros` as an
     * integer (§12.3). This is the "cost" of the `Does` column — the run total
     * is `totalCostMicros` on the header above.
     */
    models: tachoSessionGet.output.shape.models,

    files: tachoSessionGet.output.shape.files,
    commands: tachoSessionGet.output.shape.commands,
    /** Tamper, probes, chain breaks, mandate exceptions (§6.11, §8.3). */
    incidents: tachoSessionGet.output.shape.incidents,
    /** §8.3: signed markers that fix the chain so far. */
    checkpointCount: tachoSessionGet.output.shape.checkpointCount,

    /**
     * §6.10. A receipt is the signed record of one tool call, assembled by the
     * gateway and stored as its own frame. What is returned here is the index a
     * reader scans — the ids that let them open the full six-group record, plus
     * the decision and tier a Run page badges. The full receipt, with its
     * authority, credential and effect groups, is read and exported through the
     * Audit page, because exporting it is a governed action of its own.
     *
     * `enforcementTier` is carried off the run header so a receipt can never
     * badge a stronger word than the run recorded (§7.1).
     */
    receipts: z
      .array(
        z
          .object({
            receiptFrameSeq: z.number().int().nonnegative(),
            toolCallId: z.string().min(1),
            toolVersionId: z.string().min(1),
            action: z.string().min(1),
            /** Appendix A.6 `control.tool_calls.decision`. */
            decision: z.enum(["allow", "approve", "deny"]),
            /** True when the call's arguments derive from untrusted input (§6.7). */
            tainted: z.boolean(),
            enforcementTier:
              tachoSessionGet.output.shape.session.shape.enforcementTier,
            dispatchedAt: z.string().nullable(),
          })
          .strict(),
      )
      .max(1000),
  }),
});

export type GetRunInput = z.output<typeof getRun.input>;
export type GetRunOutput = z.output<typeof getRun.output>;
