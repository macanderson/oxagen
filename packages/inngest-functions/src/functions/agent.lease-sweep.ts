import { createFunction } from "../create-function";
import { withSystemDb } from "@oxagen/database";
import { sql } from "drizzle-orm";
import { insertEvents, type EventRow } from "@oxagen/telemetry";
import { MAX_ATTEMPTS, decideSweepAction } from "../lease";
import { deriveFanoutStatus } from "./agent.execute-subagent";
import { logger } from "../logger";

/**
 * Lease sweeper (docs/specs/graph-mediated-fanout-phase2 §1): the self-healing
 * backstop for the claim/lease primitive. Every 5 minutes it:
 *
 *   1. Requeues expired-lease subagent_runs / agent_execution_steps below the
 *      attempt cap back to 'pending' and re-emits their dispatch events (the
 *      executor's claim loop picks them up); rows at the cap are failed with
 *      an explicit lease-expiry reason, which is what guarantees every child
 *      eventually becomes terminal.
 *   2. Runs the same last-child-finalize count the executors use, as a
 *      backstop — so a fanout/execution whose worker died AFTER the last
 *      child finished still terminates.
 *   3. Emits agent.lease.expired / agent.task.reclaimed telemetry rows; the
 *      self-healing MTTR metric reads straight off these.
 *
 * System-wide sweep (withSystemDb, memory.decay-pass precedent) — a cron has
 * no tenant. Concurrency 1: two overlapping sweeps would double-emit
 * re-dispatch events (harmless but noisy — claims make double-run impossible).
 */

/** Per-sweep row budget; anything beyond is picked up next tick (5 min). */
const SWEEP_BATCH_LIMIT = 500;

/** Backstop-finalize budget per sweep. */
const FINALIZE_BATCH_LIMIT = 100;

/**
 * Executions are finalized by the backstop only when quiescent for this long.
 * Unlike fanout children (batch-inserted before dispatch), execution steps
 * may be written incrementally by other surfaces — finalizing an execution
 * whose writer is still appending steps would be premature.
 */
const EXECUTION_QUIESCENT_MINUTES = 30;

type ExpiredRunRow = {
  id: string;
  org_id: string;
  workspace_id: string;
  fanout_id: string;
  attempts: number;
  claimed_by: string | null;
}

type ExpiredStepRow = {
  id: string;
  org_id: string;
  workspace_id: string;
  execution_id: string;
  step_number: number;
  input_payload: unknown;
  attempts: number;
  claimed_by: string | null;
}

type StuckFanoutRow = {
  id: string;
  org_id: string;
  workspace_id: string;
  total: number;
  completed: number;
  failed: number;
}

type StuckExecutionRow = {
  id: string;
  org_id: string;
  workspace_id: string;
  completed: number;
}

function leaseEventRow(
  eventType: "agent.lease.expired" | "agent.task.reclaimed",
  row: { org_id: string; workspace_id: string; attempts: number; claimed_by: string | null },
  payload: Record<string, unknown>,
): EventRow {
  return {
    event_id: crypto.randomUUID(),
    org_id: row.org_id,
    workspace_id: row.workspace_id,
    event_type: eventType,
    source_system: "inngest:agent.lease-sweep",
    stream_offset: null,
    payload: JSON.stringify({ ...payload, attempts: Number(row.attempts), claimedBy: row.claimed_by }),
    emitted_at: new Date().toISOString(),
  };
}

export const [agentLeaseSweep] = createFunction(
  { id: "agent.lease-sweep", retries: 3, concurrency: { limit: 1 } },
  { cron: "*/5 * * * *" },
  async ({ step }) => {
    // ── 1a. Expired subagent_runs: requeue below the cap, fail at it ────────
    const runSweep = await step.run("sweep-subagent-runs", () =>
      withSystemDb(async (tx) => {
        const expired = (await tx.execute<ExpiredRunRow>(sql`
          SELECT id, org_id, workspace_id, fanout_id, attempts, claimed_by
          FROM agent.subagent_runs
          WHERE status = 'running' AND lease_expires_at < now()
          ORDER BY lease_expires_at
          LIMIT ${SWEEP_BATCH_LIMIT}
          FOR UPDATE SKIP LOCKED
        `)) as unknown as ExpiredRunRow[];
        if (expired.length === 0) return { expired: [], requeued: [], failed: [] };

        const requeueIds = expired.filter((r) => decideSweepAction(Number(r.attempts)) === "requeue").map((r) => r.id);
        const failIds = expired.filter((r) => decideSweepAction(Number(r.attempts)) === "fail").map((r) => r.id);

        // Re-check the expiry in each UPDATE guard: a still-live worker may
        // have renewed between our SELECT and this write.
        if (requeueIds.length > 0) {
          await tx.execute(sql`
            UPDATE agent.subagent_runs
            SET status = 'pending', claimed_by = NULL, lease_expires_at = NULL, updated_at = now()
            WHERE id = ANY(${requeueIds}::uuid[])
              AND status = 'running' AND lease_expires_at < now()
          `);
        }
        if (failIds.length > 0) {
          await tx.execute(sql`
            UPDATE agent.subagent_runs
            SET status = 'failed',
                error_reason = 'lease expired after ' || attempts || ' attempts',
                summary = 'lease expired after ' || attempts || ' attempts',
                completed_at = now(), lease_expires_at = NULL, updated_at = now()
            WHERE id = ANY(${failIds}::uuid[])
              AND status = 'running' AND lease_expires_at < now()
          `);
        }
        return {
          expired,
          requeued: expired.filter((r) => requeueIds.includes(r.id)),
          failed: expired.filter((r) => failIds.includes(r.id)),
        };
      }),
    );

    // ── 1b. Expired agent_execution_steps ───────────────────────────────────
    const stepSweep = await step.run("sweep-execution-steps", () =>
      withSystemDb(async (tx) => {
        const expired = (await tx.execute<ExpiredStepRow>(sql`
          SELECT id, org_id, workspace_id, execution_id, step_number, input_payload, attempts, claimed_by
          FROM agent.agent_execution_steps
          WHERE status = 'running' AND lease_expires_at < now()
          ORDER BY lease_expires_at
          LIMIT ${SWEEP_BATCH_LIMIT}
          FOR UPDATE SKIP LOCKED
        `)) as unknown as ExpiredStepRow[];
        if (expired.length === 0) return { expired: [], requeued: [], failed: [] };

        const requeueIds = expired.filter((r) => decideSweepAction(Number(r.attempts)) === "requeue").map((r) => r.id);
        const failIds = expired.filter((r) => decideSweepAction(Number(r.attempts)) === "fail").map((r) => r.id);

        if (requeueIds.length > 0) {
          await tx.execute(sql`
            UPDATE agent.agent_execution_steps
            SET status = 'pending', claimed_by = NULL, lease_expires_at = NULL, updated_at = now()
            WHERE id = ANY(${requeueIds}::uuid[])
              AND status = 'running' AND lease_expires_at < now()
          `);
        }
        if (failIds.length > 0) {
          await tx.execute(sql`
            UPDATE agent.agent_execution_steps
            SET status = 'failed',
                failure_reason = 'lease expired after ' || attempts || ' attempts',
                completed_at = now(), lease_expires_at = NULL, updated_at = now()
            WHERE id = ANY(${failIds}::uuid[])
              AND status = 'running' AND lease_expires_at < now()
          `);
        }
        return {
          expired,
          requeued: expired.filter((r) => requeueIds.includes(r.id)),
          failed: expired.filter((r) => failIds.includes(r.id)),
        };
      }),
    );

    // ── 2a. Re-dispatch fanouts with requeued children ──────────────────────
    const fanoutEvents = new Map<string, { orgId: string; workspaceId: string; fanoutId: string }>();
    for (const r of runSweep.requeued) {
      fanoutEvents.set(r.fanout_id, { orgId: r.org_id, workspaceId: r.workspace_id, fanoutId: r.fanout_id });
    }
    if (fanoutEvents.size > 0) {
      await step.sendEvent(
        "redispatch-fanouts",
        [...fanoutEvents.values()].map((data) => ({ name: "agent/subagent.dispatch", data })),
      );
    }

    // ── 2b. Re-dispatch requeued workflow steps ─────────────────────────────
    if (stepSweep.requeued.length > 0) {
      await step.sendEvent(
        "redispatch-steps",
        stepSweep.requeued.map((r) => {
          const payload = (r.input_payload ?? {}) as Record<string, unknown>;
          return {
            name: "agent/workflow.task.execute",
            data: {
              orgId: r.org_id,
              workspaceId: r.workspace_id,
              executionId: r.execution_id,
              stepId: r.id,
              taskIndex: Number(r.step_number),
              goal: typeof payload.goal === "string" ? payload.goal : "",
              outputFormat: typeof payload.outputFormat === "string" ? payload.outputFormat : "markdown",
            },
          };
        }),
      );
    }

    // ── 3a. Backstop finalize: fanouts whose children are all terminal ──────
    // Covers the worker that died AFTER the last child finished but BEFORE
    // the finalize step. Children are batch-inserted at dispatch, so
    // all-terminal here genuinely means done.
    const finalizedFanouts = await step.run("finalize-stuck-fanouts", () =>
      withSystemDb(async (tx) => {
        const stuck = (await tx.execute<StuckFanoutRow>(sql`
          SELECT f.id, f.org_id, f.workspace_id,
                 count(r.id)::int AS total,
                 (count(*) filter (where r.status = 'completed'))::int AS completed,
                 (count(*) filter (where r.status = 'failed'))::int AS failed
          FROM agent.subagent_fanouts f
          JOIN agent.subagent_runs r ON r.fanout_id = f.id
          WHERE f.status IN ('pending', 'running')
          GROUP BY f.id, f.org_id, f.workspace_id
          HAVING count(*) filter (where r.status IN ('pending', 'running')) = 0
          LIMIT ${FINALIZE_BATCH_LIMIT}
        `)) as unknown as StuckFanoutRow[];

        const finalized: (StuckFanoutRow & { finalStatus: "completed" | "failed" | "partial" })[] = [];
        for (const f of stuck) {
          const finalStatus = deriveFanoutStatus(Number(f.completed), Number(f.total), Number(f.failed) > 0);
          // Same column mapping as the executor: the status CHECK has no
          // 'failed'; aggregate recomputes true 'failed' from per-run counts.
          const columnStatus = finalStatus === "failed" ? "partial" : finalStatus;
          const rows = (await tx.execute<{ id: string }>(sql`
            UPDATE agent.subagent_fanouts
            SET status = ${columnStatus}, completed_children = ${Number(f.completed)}, updated_at = now()
            WHERE id = ${f.id}::uuid AND status IN ('pending', 'running')
            RETURNING id
          `)) as unknown as { id: string }[];
          if (rows.length > 0) finalized.push({ ...f, finalStatus });
        }
        return finalized;
      }),
    );

    if (finalizedFanouts.length > 0) {
      await step.sendEvent(
        "backstop-fanout-completed",
        finalizedFanouts.map((f) => ({
          name: "agent/subagent.fanout.completed",
          data: {
            orgId: f.org_id,
            workspaceId: f.workspace_id,
            fanoutId: f.id,
            status: f.finalStatus,
            completedChildren: Number(f.completed),
            totalChildren: Number(f.total),
          },
        })),
      );
    }

    // ── 3b. Backstop finalize: quiescent executions with all-terminal steps ─
    const finalizedExecutions = await step.run("finalize-stuck-executions", () =>
      withSystemDb(async (tx) => {
        const stuck = (await tx.execute<StuckExecutionRow>(sql`
          SELECT e.id, e.org_id, e.workspace_id,
                 (count(*) filter (where s.status = 'completed'))::int AS completed
          FROM agent.agent_executions e
          JOIN agent.agent_execution_steps s ON s.execution_id = e.id
          WHERE e.status IN ('planning', 'running')
            AND e.updated_at < now() - make_interval(mins => ${EXECUTION_QUIESCENT_MINUTES})
          GROUP BY e.id, e.org_id, e.workspace_id
          HAVING count(*) filter (where s.status IN ('pending', 'running')) = 0
             AND max(s.updated_at) < now() - make_interval(mins => ${EXECUTION_QUIESCENT_MINUTES})
          LIMIT ${FINALIZE_BATCH_LIMIT}
        `)) as unknown as StuckExecutionRow[];

        const finalized: (StuckExecutionRow & { finalStatus: "completed" | "failed" })[] = [];
        for (const e of stuck) {
          // Same rule as agent.workflow.task.execute's finalize-execution.
          const finalStatus = Number(e.completed) > 0 ? ("completed" as const) : ("failed" as const);
          const rows = (await tx.execute<{ id: string }>(sql`
            UPDATE agent.agent_executions
            SET status = ${finalStatus}, completed_at = now(), updated_at = now()
            WHERE id = ${e.id}::uuid AND status IN ('planning', 'running')
            RETURNING id
          `)) as unknown as { id: string }[];
          if (rows.length > 0) finalized.push({ ...e, finalStatus });
        }
        return finalized;
      }),
    );

    // ── 4. Lease telemetry → ClickHouse events ──────────────────────────────
    await step.run("emit-lease-telemetry", async () => {
      const rows: EventRow[] = [
        ...runSweep.expired.map((r) =>
          leaseEventRow("agent.lease.expired", r, { kind: "subagent_run", runId: r.id, fanoutId: r.fanout_id }),
        ),
        ...runSweep.requeued.map((r) =>
          leaseEventRow("agent.task.reclaimed", r, { kind: "subagent_run", runId: r.id, fanoutId: r.fanout_id }),
        ),
        ...stepSweep.expired.map((r) =>
          leaseEventRow("agent.lease.expired", r, { kind: "execution_step", stepId: r.id, executionId: r.execution_id }),
        ),
        ...stepSweep.requeued.map((r) =>
          leaseEventRow("agent.task.reclaimed", r, { kind: "execution_step", stepId: r.id, executionId: r.execution_id }),
        ),
      ];
      if (rows.length === 0) return;
      try {
        await insertEvents(rows);
      } catch (telErr) {
        logger.warn({ err: telErr }, "insertEvents failed — lease telemetry loss");
      }
    });

    const summary = {
      runsRequeued: runSweep.requeued.length,
      runsFailedAtCap: runSweep.failed.length,
      stepsRequeued: stepSweep.requeued.length,
      stepsFailedAtCap: stepSweep.failed.length,
      fanoutsFinalized: finalizedFanouts.length,
      executionsFinalized: finalizedExecutions.length,
      maxAttempts: MAX_ATTEMPTS,
    };
    logger.info(summary, "agent.lease-sweep: sweep complete");
    return summary;
  },
);
