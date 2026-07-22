import { z } from "zod";
import { registerCapability } from "../registry";

// query_lineage — the data spine for the fleet-lineage explorer (issue #1078).
// Returns the full dispatch tree rooted at one agent.subagent_fanouts row: a
// flat, depth-annotated adjacency list of every subagent RUN in the tree, each
// carrying its principal (+ delegation ceiling), observed ClickHouse spend,
// model/provider, and a derived outcome. This output shape is a PUBLIC
// INTERFACE consumed by other surfaces (app UI, CLI) built against this
// contract — every field below is doc-commented for that reason; do not
// rename or reshape without updating every consumer.

/**
 * Who drove this run's spend, resolved from ClickHouse `token_usage.principal_id`
 * against Postgres `iam.principals`. NEVER render `id` as the node's identity —
 * `displayName` is always populated (falls back to "Unknown principal" when the
 * id can't be resolved) specifically so the UI never has to fall back to a raw
 * UUID.
 */
const lineagePrincipalRef = z.object({
  /**
   * `iam.principals.id`, or null when ClickHouse recorded no principal
   * attribution for this run (pre-attribution write, or the non-enterprise
   * IAM fast-path) — i.e. spend exists but who-drove-it does not.
   */
  id: z.string().nullable(),
  kind: z.enum(["human", "agent", "service"]).nullable(),
  /** Human-readable name. Always a real string — never a bare id. */
  displayName: z.string(),
});

/**
 * The delegation ceiling (Agent RBAC: agent ∩ invoking-human, deny-wins) —
 * the human principal whose authority bounds this run's agent principal via
 * `iam.principals.parentUserId`. Null when the run's principal is itself
 * human/service (no ceiling applies) or could not be resolved.
 */
const lineageDelegationCeiling = z
  .object({
    principalId: z.string(),
    displayName: z.string(),
  })
  .nullable();

const lineageSpend = z.object({
  /**
   * Observed spend for this run's execution step, converted from ClickHouse
   * `token_usage.cost_usd_micros` to plain USD (already divided by 1,000,000)
   * — never micro-USD at this boundary. Zero when no token_usage rows are
   * attributed to this run OR the ClickHouse read degraded (see the
   * top-level note on graceful degradation).
   */
  costUsd: z.number().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  /** Count of token_usage rows (LLM calls) attributed to this run. */
  llmCalls: z.number().int().nonnegative(),
});

/**
 * A denial captured on this run, parsed from `subagent_runs.error_reason`.
 *
 * HONESTY NOTE (do not "complete" this without re-reading it): this is
 * populated by pattern-matching the kernel's IAM-denial error message
 * (`IAM denied "<capability>" for principal: <reason>` /
 * `IAM requires approval for "<capability>" — …`), which IS durably recorded
 * on every denied run today. It CAN be non-null in production. However it
 * reflects a GENERIC authz denial, not specifically an Agent-RBAC
 * delegation-ceiling violation (`agent_delegation:*`) — the subagent executor
 * (packages/inngest-functions/src/functions/agent.execute-subagent.ts) builds
 * its CapabilityContext without `ctx.agentRun`, so the agent ∩ human
 * delegation-ceiling resolution path in packages/iam/src/check-iam.ts never
 * runs for subagent-dispatched capabilities, and no `agent_delegation:*`
 * decision reason or audit-row lineage is ever produced for these runs. When
 * that wiring lands this field will start surfacing true delegation-ceiling
 * outcomes with no shape change. Do not read a non-null value here as proof
 * the delegation ceiling specifically was violated — only that IAM denied
 * the call.
 */
const lineageDelegationViolation = z
  .object({
    /** The denial reason token parsed out of the kernel's error message (or "pending_approval"). */
    ruleId: z.string(),
    /** The raw `subagent_runs.error_reason` this was parsed from. */
    message: z.string(),
  })
  .nullable();

/**
 * Derived outcome — NEVER the raw DB `status` column. `subagent_runs.status`
 * has no 'cancelled' value (CHECK constraint permits only pending/running/
 * completed/failed); a cancel sets status='failed' with
 * error_reason='Cancelled by agent.subagent.cancel'. This field decodes that
 * so a cancelled run is never mistaken for a genuine failure.
 */
const lineageOutcome = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

const lineageNode = z.object({
  /** `subagent_runs.public_id` (sar_…) — the run this node represents. */
  runId: z.string(),
  /**
   * `public_id` of the dispatch batch (`subagent_fanouts`) this run belongs
   * to. Equals `dispatchId` for every depth-0 node; a nested batch's own
   * public id for deeper nodes.
   */
  fanoutId: z.string(),
  /**
   * `runId` of the run whose OWN dispatch produced this node's batch. Null
   * for a depth-0 node — a direct child of the root fanout named by
   * `dispatchId`. Walk this pointer to reconstruct the tree client-side.
   */
  parentRunId: z.string().nullable(),
  /**
   * `public_id` of the fanout THIS run itself dispatched (i.e. this run
   * decomposed further into its own subagent batch), whenever one exists —
   * populated by a plain existence check, INDEPENDENT of whether that child
   * fanout's own runs made it into this response (they may not have, due to
   * `maxDepth`/`maxNodes` truncation). Null only when this run is a genuine
   * leaf (never dispatched further).
   *
   * To find out whether the children are actually present in `nodes`, check
   * whether some other node has `parentRunId` equal to this node's `runId`.
   * If `childFanoutId` is set but no such node exists, re-query with this
   * value as the new `dispatchId` (or a larger `maxDepth`/`maxNodes`) to see
   * the rest of the tree — this is exactly what `maxDepthReached` signals at
   * the deepest walked level. When more than one fanout row shares the same
   * `parent_message_id` (should not happen by construction, but is not
   * DB-enforced), the earliest-created one is chosen deterministically.
   */
  childFanoutId: z.string().nullable(),
  /** 0 = direct child of the root fanout; each nested dispatch adds 1. */
  depth: z.number().int().nonnegative(),
  capabilityName: z.string(),
  outcome: lineageOutcome,
  /** `subagent_runs.attempts` — how many claim/lease cycles this run took. */
  attempts: z.number().int().nonnegative(),
  principal: lineagePrincipalRef,
  delegationCeiling: lineageDelegationCeiling,
  /** `token_usage.model`, null when no usage rows are attributed to this run. */
  model: z.string().nullable(),
  /** `token_usage.provider`, null when no usage rows are attributed to this run. */
  provider: z.string().nullable(),
  spend: lineageSpend,
  delegationViolation: lineageDelegationViolation,
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  /** Wall-clock duration once the run has completed; null otherwise. */
  durationMs: z.number().int().nullable(),
});

export const lineageQuery = registerCapability({
  name: "query_lineage",
  domain: "lineage",
  description:
    "Return the dispatch tree for one fan-out/run id — every subagent run reachable from a root dispatch, each carrying its principal (and Agent-RBAC delegation ceiling), observed ClickHouse spend, model/provider, and a derived outcome (pending/running/completed/failed/cancelled). Read-only; the data spine for the fleet-lineage explorer.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent", "cli"],
  layers: ["schema", "api", "docs", "mcp", "unit", "app"],
  scoped: true,
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "introspection",
  },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  input: z.object({
    dispatchId: z
      .string()
      .min(1)
      .describe(
        "Public ID of the root fan-out (agent.subagent_fanouts.publicId) — the dispatchId returned by dispatch_subagent.",
      ),
    maxDepth: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(5)
      .describe(
        "Maximum nesting depth to walk — a run dispatching its own subagents counts as one level. 1-10, default 5.",
      ),
    maxNodes: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(200)
      .describe(
        "Maximum number of run nodes to return across the whole tree. 1-500, default 200; see `truncated` in the output.",
      ),
  }),
  output: z.object({
    dispatchId: z.string(),
    /**
     * Raw `subagent_fanouts.status` of the ROOT batch only — NOT a per-run
     * outcome. Read each node's own `outcome` for run-level state.
     */
    rootStatus: z.enum([
      "pending",
      "running",
      "completed",
      "partial",
      "timed_out",
    ]),
    totalChildren: z.number().int(),
    completedChildren: z.number().int(),
    createdAt: z.string(),
    updatedAt: z.string(),
    /**
     * Flat adjacency list of every run in the tree — NOT nested JSON.
     * Depth-0 nodes are direct children of the root fanout; reconstruct the
     * tree client-side by grouping on `parentRunId`.
     */
    nodes: z.array(lineageNode),
    nodeCount: z.number().int().nonnegative(),
    /**
     * True when the tree has more run nodes than `maxNodes` — `nodes` was
     * cut off (ordered breadth-first by depth, then chronologically).
     */
    truncated: z.boolean(),
    /**
     * True when at least one RETURNED node at the deepest allowed depth
     * (`maxDepth - 1`) has its own `childFanoutId` set — i.e. the tree
     * provably continues beyond what was walked. Re-query with a larger
     * `maxDepth`, or call query_lineage again using that node's
     * `childFanoutId` as the new `dispatchId`.
     */
    maxDepthReached: z.boolean(),
  }),
});

export type LineageQueryInput = z.output<typeof lineageQuery.input>;
export type LineageQueryOutput = z.output<typeof lineageQuery.output>;
export type LineageNodeDto = z.output<
  typeof lineageQuery.output
>["nodes"][number];
