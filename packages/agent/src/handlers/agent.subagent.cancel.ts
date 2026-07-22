import { withTenantDb, schema } from "@oxagen/database";
import { and, eq, inArray } from "drizzle-orm";
import { insertEvents } from "@oxagen/telemetry";
import pino from "pino";
import type { CapabilityContext } from "../types";
import type {
  AgentSubagentCancelInput,
  AgentSubagentCancelOutput,
} from "@oxagen/oxagen/contracts/agent.subagent.cancel";
import { FanoutNotFoundError } from "./subagent-errors";
import { CANCEL_ERROR_REASON } from "../dispatch/lineage-outcome";
import { projectSubagentFanoutLineage } from "../dispatch/lineage-projection";

export type { AgentSubagentCancelInput, AgentSubagentCancelOutput };

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "agent.subagent.cancel" },
});

// STATUS-TRANSITION NOTE (HALTED SUB-SLICE):
//
// The `subagent_fanouts.status` column has a CHECK constraint permitting only:
//   ('pending', 'running', 'completed', 'partial', 'timed_out')
// The `subagent_runs.status` column has a CHECK constraint permitting only:
//   ('pending', 'running', 'completed', 'failed')
//
// Neither table includes 'cancelled'. Adding it requires a schema migration
// (new CHECK constraint values). Because the Atlas CLI migration flow was not
// available in this context, the status-transition sub-slice is HALTED for
// the migration step and we use the closest available terminal statuses:
//   - fanout  → 'timed_out'  (the only terminal non-success fanout state)
//   - runs    → 'failed'     (the only terminal non-success run state)
//
// Once a migration adds 'cancelled' to both CHECK constraints, replace
// FANOUT_CANCEL_STATUS and RUN_CANCEL_STATUS below with 'cancelled'.
const FANOUT_CANCEL_STATUS = "timed_out" as const;
const RUN_CANCEL_STATUS = "failed" as const;

// CANCEL_ERROR_REASON is the single source of truth (packages/agent/src/dispatch/lineage-outcome.ts) —
// query_lineage's deriveLineageOutcome and the fleet-lineage graph projection
// both decode this exact string to distinguish a cancellation from a genuine
// failure, so it must never drift from the literal written below.

// Non-terminal run statuses — only these rows are transitioned on cancel.
const NON_TERMINAL_RUN_STATUSES = ["pending", "running"] as const;

export async function agentSubagentCancelHandler(
  input: AgentSubagentCancelInput,
  ctx: CapabilityContext,
): Promise<AgentSubagentCancelOutput> {
  const started = Date.now();

  // 1. Verify the fanout exists and belongs to this org + workspace.
  const fanout = await withTenantDb(async (tx) => {
    const [row] = await tx
      .select({
        id: schema.subagentFanouts.id,
        publicId: schema.subagentFanouts.publicId,
        status: schema.subagentFanouts.status,
      })
      .from(schema.subagentFanouts)
      .where(
        and(
          eq(schema.subagentFanouts.publicId, input.fanoutId),
          eq(schema.subagentFanouts.orgId, ctx.orgId),
          eq(schema.subagentFanouts.workspaceId, ctx.workspaceId),
        ),
      )
      .limit(1);
    return row ?? null;
  });

  if (!fanout) throw new FanoutNotFoundError(input.fanoutId);

  // 2. Transition non-terminal child runs to the terminal cancel status.
  //    Scope by orgId + workspaceId + fanoutId so no other tenant's runs
  //    are ever touched, even if fanoutId collides across tenants.
  const updatedRuns = await withTenantDb(async (tx) => {
    // Fetch the public IDs of non-terminal runs so we know the exact count.
    const nonTerminalRows = await tx
      .select({ publicId: schema.subagentRuns.publicId })
      .from(schema.subagentRuns)
      .where(
        and(
          // subagentRuns.fanoutId is the internal uuid FK (subagentFanouts.id),
          // NOT the public id. Use the resolved fanout.id from step 1 — matching
          // agent.subagent.aggregate.ts (loadRuns) and agent.subagent.fanout.get.ts.
          eq(schema.subagentRuns.fanoutId, fanout.id),
          eq(schema.subagentRuns.orgId, ctx.orgId),
          eq(schema.subagentRuns.workspaceId, ctx.workspaceId),
          inArray(schema.subagentRuns.status, [...NON_TERMINAL_RUN_STATUSES]),
        ),
      );

    if (nonTerminalRows.length > 0) {
      await tx
        .update(schema.subagentRuns)
        .set({
          status: RUN_CANCEL_STATUS,
          errorReason: CANCEL_ERROR_REASON,
          completedAt: new Date(),
        })
        .where(
          inArray(
            schema.subagentRuns.publicId,
            nonTerminalRows.map((r) => r.publicId),
          ),
        );
    }

    return nonTerminalRows.length;
  });

  // 3. Transition the fanout itself to the terminal cancel status.
  //    Only update if it is not already in a terminal state so repeated
  //    cancel calls are idempotent.
  await withTenantDb(async (tx) => {
    await tx
      .update(schema.subagentFanouts)
      .set({ status: FANOUT_CANCEL_STATUS })
      .where(
        and(
          eq(schema.subagentFanouts.publicId, input.fanoutId),
          eq(schema.subagentFanouts.orgId, ctx.orgId),
          eq(schema.subagentFanouts.workspaceId, ctx.workspaceId),
          inArray(schema.subagentFanouts.status, ["pending", "running"]),
        ),
      );
  });

  // 4. Meter the cancel event to ClickHouse. Best-effort — telemetry must
  //    never fail a successful operation.
  const durationMs = Date.now() - started;
  await emitCancelTelemetry(ctx, input.fanoutId, updatedRuns, durationMs).catch(
    () => undefined,
  );

  // 5. Project the (now cancel-terminal) dispatch tree into Neo4j — best
  //    effort, non-blocking. A graph write failure must never fail a
  //    successful cancel (mirrors the telemetry swallow above). Cancellation
  //    is encoded, not a status (see the STATUS-TRANSITION NOTE above), so
  //    this reads back through the SAME deriveLineageOutcome the graph
  //    projection uses — a cancelled run is never mistaken for a genuine
  //    failure in the graph either.
  await projectSubagentFanoutLineage({
    fanoutId: fanout.id,
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
  }).catch((err: unknown) => {
    logger.warn(
      { err, fanoutId: input.fanoutId },
      "agent.subagent.cancel: lineage graph projection failed — cancel still succeeds",
    );
  });

  return {
    fanoutId: input.fanoutId,
    status: FANOUT_CANCEL_STATUS,
    cancelledChildren: updatedRuns,
  };
}

async function emitCancelTelemetry(
  ctx: CapabilityContext,
  fanoutId: string,
  cancelledChildren: number,
  durationMs: number,
): Promise<void> {
  await insertEvents([
    {
      event_id: crypto.randomUUID(),
      org_id: ctx.orgId,
      workspace_id: ctx.workspaceId,
      event_type: "agent.subagent.cancel.ran",
      source_system: `handler:${ctx.surface}`,
      stream_offset: null,
      payload: JSON.stringify({
        capability: "cancel_subagent",
        fanoutId,
        cancelledChildren,
        durationMs,
        requestId: ctx.requestId,
      }),
      emitted_at: new Date().toISOString(),
    },
  ]);
}
