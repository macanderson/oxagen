import { withTenantDb, schema } from "@oxagen/database";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { getInngestClient } from "../dispatch/inngest-client";
import { getOxagenRegistry } from "../registry-loader";
import { resolveAgentRunCapability } from "@oxagen/oxagen/iam";
import type { CapabilityContext } from "../types";
import { effectiveResourceScope, auditScopeDenial } from "./_effective-scope";
import type {
  AgentSubagentDispatchInput,
  AgentSubagentDispatchOutput,
} from "@oxagen/oxagen/contracts/agent.subagent.dispatch";

export type { AgentSubagentDispatchInput, AgentSubagentDispatchOutput };

// Per-risk-level ceiling (seconds) for a dispatched task. A caller-supplied
// timeoutSeconds is clamped to the ceiling of the riskiest capability in the
// batch so a single high-risk task can't be parked on the worker for the full
// contract max (3600s). Unknown/absent risk defaults to the medium ceiling.
const TIMEOUT_CEILING_BY_RISK: Record<"low" | "medium" | "high", number> = {
  low: 900,
  medium: 600,
  high: 300,
};

/**
 * Total-descendant cap for a root fanout tree (Phase 2 §4). Depth (3) and
 * width (100/dispatch) are enforced elsewhere, but per-level caps alone allow
 * a 3-deep × 100-wide ≈ 10⁶ explosion; this bounds the whole tree. Exported
 * for unit tests.
 */
export const MAX_TOTAL_DESCENDANTS = 250;

/**
 * Count every subagent run already in this dispatch's root fanout tree: walk
 * UP the parent_message_id ↔ child_message_id lineage to the root message,
 * then count the whole subtree below it. One recursive CTE, org-scoped on
 * every join; lvl guards bound the walk far beyond MAX_FANOUT_DEPTH so a
 * corrupt lineage cycle can never hang the dispatch.
 */
async function countRootTreeDescendants(
  orgId: string,
  parentMessageId: string,
): Promise<number> {
  const rows = await withTenantDb((tx) =>
    tx.execute<{ descendant_count: number }>(sql`
      WITH RECURSIVE up AS (
        SELECT ${parentMessageId}::uuid AS message_id, 0 AS lvl
        UNION ALL
        SELECT f.parent_message_id, up.lvl + 1
        FROM up
        JOIN agent.subagent_runs r
          ON r.child_message_id = up.message_id AND r.org_id = ${orgId}::uuid
        JOIN agent.subagent_fanouts f
          ON f.id = r.fanout_id AND f.org_id = ${orgId}::uuid
        WHERE up.lvl < 10
      ),
      root AS (
        SELECT u.message_id FROM up u
        WHERE NOT EXISTS (
          SELECT 1 FROM agent.subagent_runs r2
          WHERE r2.child_message_id = u.message_id AND r2.org_id = ${orgId}::uuid
        )
        ORDER BY u.lvl DESC
        LIMIT 1
      ),
      down AS (
        SELECT r.id, r.child_message_id, 0 AS lvl
        FROM root
        JOIN agent.subagent_fanouts f
          ON f.parent_message_id = root.message_id AND f.org_id = ${orgId}::uuid
        JOIN agent.subagent_runs r
          ON r.fanout_id = f.id AND r.org_id = ${orgId}::uuid
        UNION ALL
        SELECT r2.id, r2.child_message_id, down.lvl + 1
        FROM down
        JOIN agent.subagent_fanouts f2
          ON f2.parent_message_id = down.child_message_id AND f2.org_id = ${orgId}::uuid
        JOIN agent.subagent_runs r2
          ON r2.fanout_id = f2.id AND r2.org_id = ${orgId}::uuid
        WHERE down.lvl < 10
      )
      SELECT count(*)::int AS descendant_count FROM down
    `),
  );
  const row = (rows as unknown as { descendant_count: number }[])[0];
  return Number(row?.descendant_count ?? 0);
}

export async function agentSubagentDispatchHandler(
  input: AgentSubagentDispatchInput,
  ctx: CapabilityContext,
): Promise<AgentSubagentDispatchOutput> {
  const { parentMessageId, tasks, maxParallel = 5 } = input;

  // Validate every capabilityName against the registry BEFORE creating any
  // rows. An unvalidated typo would otherwise persist a subagent_runs row the
  // worker can never execute (a silent dead run). Reject the whole batch with
  // a clear error, and compute the strictest timeout ceiling for the batch.
  const { getCapability } = await getOxagenRegistry();
  const unknownNames: string[] = [];
  let ceiling = TIMEOUT_CEILING_BY_RISK.low;

  // Agent RBAC Phase 4 (spec §2.7): a delegated run's fan-out can only NARROW
  // its own authority. In this architecture a dispatched child is a capability
  // task (not a nested named agent), so both allow-lists bind on the task's
  // capabilityName: (a) the effective agents.refs list — the role's explicit
  // "what this agent may fan out to" ceiling (undefined = no extra ceiling
  // beyond the agent's own capability grants); (b) the run's own effective
  // capability outcome via the SAME cached resolution the kernel enforces —
  // a capability this run could not invoke directly cannot be laundered
  // through a subagent either (fail fast here; the executor's kernel gate is
  // the backstop). Humans / non-delegated runs carry no scope → unchanged.
  const agentRun = ctx.agentRun;
  const dispatchRefs = effectiveResourceScope(ctx)?.agents?.refs;
  const scopeDenied: string[] = [];

  for (const task of tasks) {
    const cap = getCapability(task.capabilityName);
    if (!cap) {
      unknownNames.push(task.capabilityName);
      continue;
    }
    const risk = cap.agent?.riskLevel ?? "medium";
    ceiling = Math.min(ceiling, TIMEOUT_CEILING_BY_RISK[risk]);

    if (
      dispatchRefs !== undefined &&
      !dispatchRefs.includes(task.capabilityName)
    ) {
      scopeDenied.push(task.capabilityName);
      continue;
    }
    if (agentRun?.resolution) {
      const perms = resolveAgentRunCapability(agentRun, agentRun.resolution, {
        capability: task.capabilityName,
        scope: {
          kind: "workspace",
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
        },
        defaultEffect: cap.defaultEffect ?? "deny",
      });
      if (perms.outcome === "deny") scopeDenied.push(task.capabilityName);
    }
  }
  if (unknownNames.length > 0) {
    throw new Error(
      `Unknown capability name(s) in dispatch: ${[...new Set(unknownNames)].join(", ")}`,
    );
  }
  if (scopeDenied.length > 0) {
    const denied = [...new Set(scopeDenied)];
    auditScopeDenial({
      ctx,
      capability: "dispatch_subagents",
      rule: "agent_subagent_scope",
      description: `Dispatch rejected: capability task(s) outside the agent's effective scope: ${denied.join(", ")}`,
      rawInputJson: JSON.stringify({ parentMessageId, denied }),
      target: { kind: "fanout", id: parentMessageId },
    });
    throw new Error(
      `Dispatch rejected: the agent's role scope does not permit fanning out to: ${denied.join(", ")}. ` +
        `A subagent can only narrow, never widen, this run's authority.`,
    );
  }

  // Clamp the (already 1..3600-bounded) timeout to the batch risk ceiling.
  const timeoutSeconds =
    input.timeoutSeconds === undefined
      ? undefined
      : Math.min(input.timeoutSeconds, ceiling);

  // Total-descendant budget (Phase 2 §4): a nested dispatch that would push
  // its ROOT fanout tree past the cap is rejected before any row is created.
  // The worker should decompose less aggressively or summarize what it has.
  const existingDescendants = await countRootTreeDescendants(
    ctx.orgId,
    parentMessageId,
  );
  if (existingDescendants + tasks.length > MAX_TOTAL_DESCENDANTS) {
    throw new Error(
      `Dispatch rejected: root fanout tree already has ${existingDescendants} descendant task(s); ` +
        `adding ${tasks.length} would exceed the total-descendant cap of ${MAX_TOTAL_DESCENDANTS}. ` +
        `Reduce the batch or return a summary instead of decomposing further.`,
    );
  }

  // Capture BOTH ids: the internal uuid `id` is the foreign key stored on
  // subagent_runs.fanout_id (a uuid column) and the key the Inngest executor
  // matches on; the `publicId` is the external handle returned to callers and
  // accepted by agent.subagent.aggregate / agent.subagent.fanout.get.
  const [fanout] = await withTenantDb((tx) =>
    tx
      .insert(schema.subagentFanouts)
      .values({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        parentMessageId,
        status: "pending",
        totalChildren: tasks.length,
        completedChildren: 0,
      })
      .returning({
        id: schema.subagentFanouts.id,
        publicId: schema.subagentFanouts.publicId,
      }),
  );
  if (!fanout) throw new Error("subagent_fanouts insert failed");

  // Single batch insert; never per-child loop (N+1 violation). fanout_id is the
  // fan-out's uuid (FK to subagent_fanouts.id), and each child gets its OWN
  // unique childMessageId — reusing parentMessageId across rows is wrong (the
  // executor uses it as the per-child message/request id).
  await withTenantDb((tx) =>
    tx.insert(schema.subagentRuns).values(
      tasks.map((task) => ({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        fanoutId: fanout.id,
        childMessageId: randomUUID(),
        capabilityName: task.capabilityName,
        inputPayload: (task.input ?? {}) as object,
        status: "pending" as const,
      })),
    ),
  );

  // The executor (agent.execute-subagent) reads `fanoutId` (the uuid) and loads
  // the child runs from the DB itself, so we do not re-send them here. depth=1:
  // children execute one level below this root dispatch (OXA-1498 depth guard).
  //
  // Two failure modes are made observable here, because both manifested as a
  // fan-out that silently "never fires" in production:
  //   1. The emit itself throws (e.g. INNGEST_EVENT_KEY missing): the just-created
  //      child runs would otherwise be orphaned as perpetually `pending` (which
  //      the aggregate reports as `running` until its snapshot window). Mark them
  //      `failed` with the cause and rethrow a clear error so the caller surfaces
  //      it instead of returning a dispatchId that can never make progress.
  //   2. The emit succeeds but Inngest Cloud never invokes the function (app not
  //      synced / signing-key mismatch): persist the returned Inngest event id on
  //      the fan-out so the dispatch can be traced in the Inngest dashboard.
  let inngestEventId: string | null = null;
  try {
    const sent = (await getInngestClient().send({
      name: "agent/subagent.dispatch",
      data: {
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        fanoutId: fanout.id,
        depth: 1,
        maxParallel,
        timeoutSeconds,
      },
    })) as { ids?: string[] } | undefined;
    inngestEventId = sent?.ids?.[0] ?? null;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await withTenantDb((tx) =>
      tx
        .update(schema.subagentRuns)
        .set({
          status: "failed" as const,
          errorReason: `dispatch emit failed: ${reason}`,
          completedAt: new Date(),
        })
        .where(eq(schema.subagentRuns.fanoutId, fanout.id)),
    );
    throw new Error(`Failed to emit subagent dispatch event: ${reason}`);
  }

  // Persist the Inngest event id (inngest_event_id) — the breadcrumb that lets a
  // dispatch that never fired be traced from the DB row to the Inngest dashboard.
  if (inngestEventId) {
    await withTenantDb((tx) =>
      tx
        .update(schema.subagentFanouts)
        .set({ inngestEventId })
        .where(eq(schema.subagentFanouts.id, fanout.id)),
    );
  }

  return {
    dispatchId: fanout.publicId,
    totalTasks: tasks.length,
    status: "pending",
  };
}
