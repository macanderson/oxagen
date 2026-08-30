import { withTenantDb, schema } from "@oxagen/database";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  lineageQuery,
  type LineageNodeDto,
  type LineageQueryOutput,
} from "@oxagen/oxagen/contracts/lineage.query";
import {
  CANCEL_ERROR_REASON,
  deriveLineageOutcome,
  FanoutNotFoundError,
} from "@oxagen/agent";
import {
  NIL_UUID,
  sumTokenUsageByExecutionStep,
  type TokenUsageByStepRow,
} from "@oxagen/telemetry";
import { logger } from "./logger";

// deriveLineageOutcome + CANCEL_ERROR_REASON live in @oxagen/agent
// (packages/agent/src/dispatch/lineage-outcome.ts) — the fleet-lineage graph
// projection (packages/agent/src/dispatch/lineage-projection.ts) needs the
// exact same derivation and @oxagen/handlers already depends on @oxagen/agent
// (not the reverse), so this re-exports rather than duplicating the logic.
export { deriveLineageOutcome };

// query_lineage — walks the dispatch tree rooted at one agent.subagent_fanouts
// row. Data flow:
//   1. Resolve the root fan-out (tenant-scoped by publicId).
//   2. One recursive CTE over agent.subagent_runs/subagent_fanouts walks the
//      tree — the recursion spine is subagent_runs.child_message_id =
//      subagent_fanouts.parent_message_id (same idiom as
//      packages/agent/src/handlers/agent.subagent.dispatch.ts's
//      countRootTreeDescendants).
//   3. Spend/model/principal come from ClickHouse token_usage, batched by
//      execution_step_id = child_message_id.
//   4. Principal display names + delegation ceilings come from Postgres
//      iam.principals, batched by the principal ids ClickHouse returned.
// Step 3+4 are kept OUT of assembleLineageTree (below) so that function stays
// pure and every tree-shape/outcome/truncation scenario is unit-testable
// without a DB or ClickHouse mock.

/** One row returned by the recursive dispatch-tree CTE (see walkDispatchTree). */
interface TreeRow extends Record<string, unknown> {
  public_id: string;
  child_message_id: string;
  capability_name: string;
  status: string;
  error_reason: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  attempts: number;
  /** null for a depth-0 row (direct child of the root fan-out). */
  parent_run_public_id: string | null;
  /** public_id of the fan-out THIS row belongs to. */
  own_fanout_public_id: string;
  depth: number;
  /**
   * public_id of the fan-out THIS row itself spawned, whenever one exists —
   * a plain existence check (see the LEFT JOIN LATERAL below), independent
   * of whether that child fan-out's own runs were walked into `tree`.
   */
  child_fanout_id: string | null;
}

interface PrincipalRow {
  id: string;
  kind: string;
  displayName: string;
  parentUserId: string | null;
  status: string;
}

// The kernel's exact IAM-denial message shapes (packages/oxagen/src/kernel.ts)
// — see the caveat on the contract's delegationViolation field for what this
// can and cannot prove.
const IAM_DENIED_RE = /^IAM denied "[^"]+" for principal: (.+)$/;
const IAM_PENDING_APPROVAL_PREFIX = 'IAM requires approval for "';

/**
 * Parse `error_reason` for the kernel's IAM-denial message shape. See the
 * caveat on `delegationViolation` in the contract file for exactly what
 * a non-null result does and does not prove.
 */
export function parseDelegationViolation(
  status: string,
  errorReason: string | null,
): { ruleId: string; message: string } | null {
  if (
    status !== "failed" ||
    !errorReason ||
    errorReason === CANCEL_ERROR_REASON
  ) {
    return null;
  }
  const denied = IAM_DENIED_RE.exec(errorReason);
  if (denied) {
    return { ruleId: denied[1] ?? "authz_denied", message: errorReason };
  }
  if (errorReason.startsWith(IAM_PENDING_APPROVAL_PREFIX)) {
    return { ruleId: "pending_approval", message: errorReason };
  }
  return null;
}

export interface AssembleLineageTreeArgs {
  rows: readonly TreeRow[];
  maxNodes: number;
  spendByStepId: ReadonlyMap<string, TokenUsageByStepRow>;
  principalsById: ReadonlyMap<string, PrincipalRow>;
  ceilingByParentUserId: ReadonlyMap<
    string,
    { id: string; displayName: string }
  >;
}

/**
 * Pure assembly: SQL rows + the two lookup maps → the public node[] shape.
 * No I/O — every tree-shape, outcome-derivation, node-cap, and
 * delegation-violation scenario is tested directly against this function.
 */
export function assembleLineageTree(args: AssembleLineageTreeArgs): {
  nodes: LineageNodeDto[];
  truncated: boolean;
} {
  const {
    rows,
    maxNodes,
    spendByStepId,
    principalsById,
    ceilingByParentUserId,
  } = args;
  const truncated = rows.length > maxNodes;
  const bounded = truncated ? rows.slice(0, maxNodes) : rows;

  const nodes: LineageNodeDto[] = bounded.map((row) => {
    const usage = spendByStepId.get(row.child_message_id);
    const principalRow =
      usage && usage.principalId !== NIL_UUID
        ? principalsById.get(usage.principalId)
        : undefined;

    const kind =
      principalRow?.kind === "human" ||
      principalRow?.kind === "agent" ||
      principalRow?.kind === "service"
        ? principalRow.kind
        : null;

    const ceiling =
      principalRow?.kind === "agent" && principalRow.parentUserId
        ? (ceilingByParentUserId.get(principalRow.parentUserId) ?? null)
        : null;

    return {
      runId: row.public_id,
      fanoutId: row.own_fanout_public_id,
      parentRunId: row.parent_run_public_id,
      childFanoutId: row.child_fanout_id,
      depth: row.depth,
      capabilityName: row.capability_name,
      outcome: deriveLineageOutcome(row.status, row.error_reason),
      attempts: row.attempts,
      principal: {
        id: principalRow?.id ?? null,
        kind,
        // Never a bare UUID — displayName always resolves to a real string.
        displayName: principalRow?.displayName ?? "Unknown principal",
      },
      delegationCeiling: ceiling
        ? { principalId: ceiling.id, displayName: ceiling.displayName }
        : null,
      model: usage?.model || null,
      provider: usage?.provider || null,
      spend: {
        // costMicros is micro-USD; the contract boundary carries plain USD.
        costUsd: usage ? usage.costMicros / 1_000_000 : 0,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        llmCalls: usage?.llmCalls ?? 0,
      },
      delegationViolation: parseDelegationViolation(
        row.status,
        row.error_reason,
      ),
      startedAt: row.started_at ? row.started_at.toISOString() : null,
      completedAt: row.completed_at ? row.completed_at.toISOString() : null,
      durationMs:
        row.started_at && row.completed_at
          ? row.completed_at.getTime() - row.started_at.getTime()
          : null,
    };
  });

  return { nodes, truncated };
}

/**
 * Walk the dispatch tree rooted at `fanoutUuid` (the root fan-out's internal
 * uuid, NOT its public id). Depth 0 = the root fan-out's direct child runs;
 * each level down is one more nested dispatch. Fetches maxNodes+1 rows so the
 * caller can detect truncation without a second COUNT query.
 */
async function walkDispatchTree(args: {
  fanoutUuid: string;
  rootFanoutPublicId: string;
  orgId: string;
  workspaceId: string;
  maxDepth: number;
  maxNodes: number;
}): Promise<TreeRow[]> {
  const {
    fanoutUuid,
    rootFanoutPublicId,
    orgId,
    workspaceId,
    maxDepth,
    maxNodes,
  } = args;
  // Recursion halts once a row at depth = maxDepth - 1 has been produced, so
  // the walk never emits a row at depth >= maxDepth.
  const depthCutoff = maxDepth - 1;
  const fetchLimit = maxNodes + 1;

  const result = await withTenantDb((tx) =>
    tx.execute<TreeRow>(sql`
      WITH RECURSIVE tree AS (
        SELECT
          r.public_id                        AS public_id,
          r.child_message_id                 AS child_message_id,
          r.capability_name                  AS capability_name,
          r.status                           AS status,
          r.error_reason                     AS error_reason,
          r.started_at                       AS started_at,
          r.completed_at                     AS completed_at,
          r.attempts                         AS attempts,
          r.created_at                       AS created_at,
          NULL::text                         AS parent_run_public_id,
          ${rootFanoutPublicId}::text        AS own_fanout_public_id,
          0                                  AS depth
        FROM agent.subagent_runs r
        WHERE r.fanout_id = ${fanoutUuid}::uuid
          AND r.org_id = ${orgId}::uuid
          AND r.workspace_id = ${workspaceId}::uuid

        UNION ALL

        SELECT
          r2.public_id,
          r2.child_message_id,
          r2.capability_name,
          r2.status,
          r2.error_reason,
          r2.started_at,
          r2.completed_at,
          r2.attempts,
          r2.created_at,
          tree.public_id      AS parent_run_public_id,
          f2.public_id        AS own_fanout_public_id,
          tree.depth + 1       AS depth
        FROM tree
        JOIN agent.subagent_fanouts f2
          ON f2.parent_message_id = tree.child_message_id
         AND f2.org_id = ${orgId}::uuid
         AND f2.workspace_id = ${workspaceId}::uuid
        JOIN agent.subagent_runs r2
          ON r2.fanout_id = f2.id
         AND r2.org_id = ${orgId}::uuid
         AND r2.workspace_id = ${workspaceId}::uuid
        WHERE tree.depth < ${depthCutoff}
      )
      SELECT
        tree.public_id,
        tree.child_message_id,
        tree.capability_name,
        tree.status,
        tree.error_reason,
        tree.started_at,
        tree.completed_at,
        tree.attempts,
        tree.parent_run_public_id,
        tree.own_fanout_public_id,
        tree.depth,
        -- The fan-out this run itself spawned, if any. Deterministic
        -- tie-break (earliest-created) in the rare case more than one
        -- fan-out row shares one parent_message_id.
        child_fanout.public_id AS child_fanout_id
      FROM tree
      LEFT JOIN LATERAL (
        SELECT cf.public_id, cf.created_at
        FROM agent.subagent_fanouts cf
        WHERE cf.parent_message_id = tree.child_message_id
          AND cf.org_id = ${orgId}::uuid
          AND cf.workspace_id = ${workspaceId}::uuid
        ORDER BY cf.created_at ASC
        LIMIT 1
      ) child_fanout ON true
      ORDER BY tree.depth ASC, tree.created_at ASC
      LIMIT ${fetchLimit}
    `),
  );
  return Array.from(result as unknown as TreeRow[]);
}

export const lineageQueryHandler: CapabilityHandler<
  typeof lineageQuery
> = async (input, ctx) => {
  const { orgId, workspaceId } = ctx;
  const { dispatchId, maxDepth, maxNodes } = input;

  // 1. Resolve the root fan-out (tenant-scoped by publicId).
  const rootFanout = await withTenantDb(async (tx) => {
    const [row] = await tx
      .select({
        id: schema.subagentFanouts.id,
        publicId: schema.subagentFanouts.publicId,
        status: schema.subagentFanouts.status,
        totalChildren: schema.subagentFanouts.totalChildren,
        completedChildren: schema.subagentFanouts.completedChildren,
        createdAt: schema.subagentFanouts.createdAt,
        updatedAt: schema.subagentFanouts.updatedAt,
      })
      .from(schema.subagentFanouts)
      .where(
        and(
          eq(schema.subagentFanouts.publicId, dispatchId),
          eq(schema.subagentFanouts.orgId, orgId),
          eq(schema.subagentFanouts.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    return row ?? null;
  });

  if (!rootFanout) throw new FanoutNotFoundError(dispatchId);

  // 2. Walk the tree.
  const rows = await walkDispatchTree({
    fanoutUuid: rootFanout.id,
    rootFanoutPublicId: rootFanout.publicId,
    orgId,
    workspaceId,
    maxDepth,
    maxNodes,
  });

  // 3. Spend/model/principal-id from ClickHouse. Never let a degraded
  // ClickHouse fail this read — degrade every node to zero spend / an
  // unresolved principal, mirroring getSpendBudgetStatuses
  // (packages/billing/src/spend-budget-gate.ts).
  const stepIds = rows.map((r) => r.child_message_id);
  let spendByStepId = new Map<string, TokenUsageByStepRow>();
  try {
    spendByStepId = await sumTokenUsageByExecutionStep({
      orgId,
      executionStepIds: stepIds,
    });
  } catch (err) {
    logger.error(
      { err, orgId, dispatchId },
      "lineage.query: ClickHouse spend read failed — degrading every node to zero spend",
    );
  }

  // 4. Batch-resolve the distinct principals ClickHouse attributed spend to.
  // NOT reusing resolveAgentRunAuthzContext
  // (packages/iam/src/agent-run-context.ts): that helper is agentId-keyed and
  // resolves ONE run's authz context from agent.agents; this needs a
  // many-principal-ids-at-once lookup keyed by the principal id ClickHouse
  // already recorded, so a dedicated batch query is the right shape here.
  const principalIds = Array.from(
    new Set(
      Array.from(spendByStepId.values())
        .map((u) => u.principalId)
        .filter((id) => id !== NIL_UUID),
    ),
  );
  const principalRows: PrincipalRow[] = principalIds.length
    ? await withTenantDb((tx) =>
        tx
          .select({
            id: schema.principals.id,
            kind: schema.principals.kind,
            displayName: schema.principals.displayName,
            parentUserId: schema.principals.parentUserId,
            status: schema.principals.status,
          })
          .from(schema.principals)
          .where(
            and(
              eq(schema.principals.orgId, orgId),
              inArray(schema.principals.id, principalIds),
            ),
          ),
      )
    : [];
  const principalsById = new Map(principalRows.map((p) => [p.id, p]));

  // 5. Delegation ceiling: for every AGENT principal found above, resolve the
  // sibling HUMAN principal sharing its parentUserId — the same relationship
  // resolveAgentRunAuthzContext walks for one agent, batched here for a whole
  // tree (packages/iam/src/agent-run-context.ts).
  const parentUserIds = Array.from(
    new Set(
      principalRows
        .filter((p) => p.kind === "agent" && p.parentUserId)
        .map((p) => p.parentUserId as string),
    ),
  );
  const ceilingRows = parentUserIds.length
    ? await withTenantDb((tx) =>
        tx
          .select({
            id: schema.principals.id,
            displayName: schema.principals.displayName,
            parentUserId: schema.principals.parentUserId,
          })
          .from(schema.principals)
          .where(
            and(
              eq(schema.principals.orgId, orgId),
              eq(schema.principals.kind, "human"),
              inArray(schema.principals.parentUserId, parentUserIds),
            ),
          ),
      )
    : [];
  const ceilingByParentUserId = new Map(
    ceilingRows
      .filter((r) => r.parentUserId !== null)
      .map((r) => [
        r.parentUserId as string,
        { id: r.id, displayName: r.displayName },
      ]),
  );

  const { nodes, truncated } = assembleLineageTree({
    rows,
    maxNodes,
    spendByStepId,
    principalsById,
    ceilingByParentUserId,
  });

  const maxDepthReached = nodes.some(
    (n) => n.depth === maxDepth - 1 && n.childFanoutId !== null,
  );

  return {
    dispatchId: rootFanout.publicId,
    rootStatus: rootFanout.status as LineageQueryOutput["rootStatus"],
    totalChildren: rootFanout.totalChildren,
    completedChildren: rootFanout.completedChildren,
    createdAt: rootFanout.createdAt.toISOString(),
    updatedAt: rootFanout.updatedAt.toISOString(),
    nodes,
    nodeCount: nodes.length,
    truncated,
    maxDepthReached,
  };
};
