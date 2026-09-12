import { z } from "zod";
import { defineTool } from "./_define";
import { agentExecutionList } from "../agent.execution.list";
import { tachoSessionList } from "../tacho.session.list";
import { sessionSummarySchema } from "../../tacho/schemas";

/**
 * §8.4's replay grade: the strongest thing a person can do with a recording,
 * computed from completeness gaps. Closed and ordered, weakest first — the
 * interface renders the recorded grade and never a stronger word.
 *
 * Declared here rather than carried: `get_tacho_session` types it
 * `z.string().nullable()`, which cannot hold that rule. §3 also bans two words
 * an open string invites (`render replay`, `re-run`). The spec is stricter than
 * the code, so the spec wins (carry rule F).
 */
export const replayGradeSchema = z.enum(["inspect", "view", "fork", "retry"]);

/**
 * §8.5's witness verdict, as stored on `cost.*`'s `verdict` column (Appendix
 * A.7) and on the `Run` node (Appendix B.1). Closed: only `flipped` marks a run
 * proven, and `unverified` explicitly means the runner could not reach a
 * conclusion — never a verdict resolved by a model. `none` is a run no witness
 * was run against.
 */
export const verdictSchema = z.enum([
  "flipped",
  "failing",
  "unmoved",
  "unsatisfied",
  "tampered",
  "unverified",
  "waived",
  "none",
]);

/**
 * Appendix E: `list_runs` — "by operator, agent, task, tier, verdict". Absorbs
 * `list_executions` and `list_tacho_sessions`. Backs §14's Fleet page.
 *
 * **One vocabulary, chosen on purpose.** The two sources describe a run's
 * outcome with different closed sets: `running | completed | aborted | crashed
 * | unknown` and `planning | running | completed | failed | cancelled`. A
 * single list cannot offer both — a filter and a row badge that disagree is
 * worse than either. `list_tacho_sessions`' set carries, because it is the one
 * attached to the rows this tool actually returns and it maps cleanly onto
 * §12.8's split of unproven spend: `completed` → completed but unverified,
 * `aborted` → cancelled or halted, `crashed` → failed, with `unknown` covering
 * the unobserved tail that `unobservedTail` already flags on the row.
 *
 * **The row is the tacho summary, extended.** `sessionSummarySchema` already
 * carries what §14's Fleet row is specified to show — enforcement tier, cost so
 * far, chain verification, the unobserved-tail flag — so it is carried whole
 * and extended with the four things Fleet and the `Does` column need and no
 * source has: replay grade, verdict, the operator, and the task reference.
 * Those four come from the `Run` node in Appendix B.1.
 *
 * **The pagination is tacho's, not the executions list's.** `list_executions`
 * pages on a `before` timestamp, which cannot express a stable position when
 * two runs share a `created_at`. The opaque cursor carries; the row cap does
 * not — see the note on `limit`.
 */
export const listRuns = defineTool({
  name: "list_runs",
  domain: "control",
  description:
    "List runs in this workspace, newest first, filtered by operator, agent, task, host, enforcement tier, outcome, or witness verdict.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,
  noBillingGate: true,

  absorbs: ["list_executions", "list_tacho_sessions"],
  drops: [
    {
      field: "status",
      from: "list_executions",
      why: "one outcome vocabulary per list; `list_tacho_sessions`' set carries because it is the one on the rows returned and it maps onto §12.8's unproven-spend split. `planning` has no equivalent — a run starts at its first frame (§8.1), so there is no pre-run state to list.",
    },
    {
      field: "before",
      from: "list_executions",
      why: "replaced by the opaque `cursor` (stable across rows sharing a timestamp) plus `since` for the time window — both carried from `list_tacho_sessions`",
    },
    {
      field: "executionId (output row)",
      from: "list_executions",
      why: "§3 retires *execution*; the row is keyed by the run's uuid on `sessionSummarySchema`",
    },
    {
      field: "originType (output row)",
      from: "list_executions",
      why: "origin is not a run filter in §14; what the work was for is the task reference (§8.1), which the row carries as `taskRef`",
    },
    {
      field: "originId (output row)",
      from: "list_executions",
      why: "follows originType — superseded by `taskRef`",
    },
    {
      field: "agentId (output row)",
      from: "list_executions",
      why: "carried under `agentKey` from `sessionSummarySchema`: §6.2 identifies an agent by its key, not by a row uuid",
    },
    {
      field: "completedAt (output row)",
      from: "list_executions",
      why: "carried as `endedAt` on `sessionSummarySchema`, alongside `lastEventAt` which a live run needs and `completedAt` cannot express",
    },
    {
      field: "latencyMs (output row)",
      from: "list_executions",
      why: "derivable from `startedAt`/`endedAt` on the row; a stored duration is a second copy of a number the row already carries and the two can disagree for a live run",
    },
    {
      field: "inputTokens (output row)",
      from: "list_executions",
      why: "§12.6 accounts tokens per model call; a run-level token pair on a list row has no `cost_basis` and cannot be reconciled (§12.4). The money figure is `totalCostMicros`.",
    },
    {
      field: "outputTokens (output row)",
      from: "list_executions",
      why: "same as inputTokens — §12.6",
    },
    {
      field: "estimatedCostUsd (output row)",
      from: "list_executions",
      why: "§12.3 requires integer micro-USD with rounding to cents happening once, at the statement line. Carried as `totalCostMicros` from `sessionSummarySchema`; a decimal string named *estimated* cannot show its basis, which §14 requires of every number that is money.",
    },
    {
      field: "createdAt (output row)",
      from: "list_executions",
      why: "a run starts at its first frame (§8.1); `startedAt` on the row is that instant, and a separate row-creation time can only disagree with it",
    },
  ],

  // `list_executions` says low, `list_tacho_sessions` says medium. Medium
  // carries: a run list names operators, agents, repositories and cost.
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "introspection",
  },
  sensitivity: "medium",
  defaultEffect: "deny",
  /**
   * The sources disagree in both directions, so each scope takes the stricter
   * side of its own disagreement. `list_tacho_sessions` grants org `Member`;
   * `list_executions` does not, and that is the stricter org set. Conversely
   * `list_tacho_sessions` grants nothing at workspace scope, which reflects
   * tacho's org-only API rather than a decision that workspace members may not
   * see their own runs — §14 puts Fleet at `/{org}/{ws}`, so the workspace
   * grants come from `list_executions`.
   */
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  /**
   * Read-only. Confirmed against both handlers:
   * `packages/agent/src/handlers/agent.execution.list.ts` and
   * `packages/handlers/src/tacho.session.list.ts` open `withTenantDb` and issue
   * selects only, with no writing helper in either import set.
   */
  mutates: false,

  input: z.object({
    /**
     * The 100-row cap from `list_executions` carries over the 200 from
     * `list_tacho_sessions`: the stricter bound, and the right one now that the
     * row carries a per-model cost figure and a verdict rather than four ints.
     */
    limit: agentExecutionList.input.shape.limit,
    /** Opaque keyset cursor, 256-char capped. See the pagination note above. */
    cursor: tachoSessionList.input.shape.cursor,
    /** Only runs started at or after this instant (RFC 3339). */
    since: tachoSessionList.input.shape.since,

    outcome: tachoSessionList.input.shape.outcome,
    hostEnrollmentId: tachoSessionList.input.shape.hostEnrollmentId,
    /** Include subagent chains; default lists root runs only (§8.2 `subagent_start`). */
    includeChildren: tachoSessionList.input.shape.includeChildren,

    // ── The four filters Appendix E names that neither source had. ──────────
    /**
     * §8.1's `initiating_principal` — the person the run is attributed to, and
     * the axis §12.7 reconciles spend along. A principal id, not an email: the
     * run identity is built by server code and never carries a user-typed name.
     */
    operator: z.string().min(1).optional(),
    /** The agent key (§6.2), matching `agentKey` on the row. */
    agent: z.string().min(1).optional(),
    /**
     * §8.1's task reference: a Linear issue, a GitHub issue or PR, or a
     * free-text goal. Matched as an exact reference, which is why it is one
     * bounded string rather than a search.
     */
    task: z.string().min(1).optional(),
    /**
     * §7.1's enforcement tier, carried by reference off the row schema so the
     * filter and the badge can never drift apart.
     */
    tier: sessionSummarySchema.shape.enforcementTier.optional(),
    /** §8.5. `flipped` is the filter that answers "which runs are proven". */
    verdict: verdictSchema.optional(),
  }),

  output: z.object({
    /**
     * `sessionSummarySchema` carried whole and extended. The four additions are
     * the `Run` node's properties from Appendix B.1 that no v1 list row had.
     */
    runs: z
      .array(
        sessionSummarySchema.extend({
          /** §8.1 `initiating_principal`. Null for a run with no attributed operator. */
          operatorId: z.string().nullable(),
          /** §8.1. Null when the work was not filed against anything. */
          taskRef: z.string().nullable(),
          /** §8.4. Never rendered as a stronger word than the recorded grade. */
          replayGrade: replayGradeSchema,
          /** §8.5. `none` when no witness was run, never null — absence is a verdict. */
          verdict: verdictSchema,
        }),
      )
      .max(200),
    nextCursor: tachoSessionList.output.shape.nextCursor,
  }),
});

export type ListRunsInput = z.output<typeof listRuns.input>;
export type ListRunsOutput = z.output<typeof listRuns.output>;
