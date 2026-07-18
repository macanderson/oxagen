import { createFunction } from "../create-function";
import { withSystemDb } from "@oxagen/database";
import { sql } from "drizzle-orm";
import { insertEvents, type EventRow } from "@oxagen/telemetry";
import { sweepExpiredFileLocks } from "@oxagen/ontology";
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
 *   1c. Same requeue-below-cap / fail-at-cap idiom for `agent.agent_runs`
 *      (agent-engine v2 Phase 2, docs/specs/agent-engine-v2/plan.md) — the
 *      durable-run worker pool's claim table (`packages/agent-runner/src/run-
 *      store.ts`). Unlike subagent_runs/execution_steps, there is no separate
 *      dispatch event to re-emit: the worker pool claims `pending` rows by
 *      polling (`claimNextRun`), so a plain status flip is enough. One extra
 *      rule this table has and the others don't: a row that is both
 *      lease-expired AND `cancel_requested` resolves to 'cancelled', never
 *      'pending' — the caller already gave up on it, and requeuing would let
 *      a cancelled run resurrect and keep executing unattended.
 *   2. Runs the same last-child-finalize count the executors use, as a
 *      backstop — so a fanout/execution whose worker died AFTER the last
 *      child finished still terminates.
 *   3. Emits agent.lease.expired / agent.task.reclaimed telemetry rows; the
 *      self-healing MTTR metric reads straight off these.
 *   4. Sweeps expired agent file locks (docs/specs/agent-file-locking/plan.md
 *      §6) — reaps HOLDS_LOCK Neo4j edges left behind by a crashed/aborted
 *      turn. This is a reclaim-only backstop: `acquireFileLock`'s lazy-expiry
 *      predicate already makes an expired lock invisible to new acquires
 *      without this sweep running, so a Neo4j outage here degrades to "stale
 *      rows accumulate until the next successful sweep", never a correctness
 *      issue for lock acquisition itself.
 *
 * System-wide sweep (withSystemDb, memory.decay-pass precedent) — a cron has
 * no tenant. Concurrency 1: two overlapping sweeps would double-emit
 * re-dispatch events (harmless but noisy — claims make double-run impossible).
 */

/** Per-sweep row budget; anything beyond is picked up next tick (5 min). */
const SWEEP_BATCH_LIMIT = 500;

/**
 * Attempt cap for `agent.agent_runs` — mirrors MAX_RUN_ATTEMPTS
 * (`packages/agent-runner/src/run-store.ts`). Hardcoded rather than imported:
 * this package takes no workspace dependency on @oxagen/agent-runner for one
 * constant. Keep the two values in sync by hand if either changes.
 */
const MAX_AGENT_RUN_ATTEMPTS = 3;

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
};

type ExpiredStepRow = {
  id: string;
  org_id: string;
  workspace_id: string;
  execution_id: string;
  step_number: number;
  input_payload: unknown;
  attempts: number;
  claimed_by: string | null;
};

type ExpiredAgentRunRow = {
  id: string;
  org_id: string;
  workspace_id: string;
  attempts: number;
  claimed_by: string | null;
  cancel_requested: boolean;
};

type StuckFanoutRow = {
  id: string;
  org_id: string;
  workspace_id: string;
  total: number;
  completed: number;
  failed: number;
};

type StuckExecutionRow = {
  id: string;
  org_id: string;
  workspace_id: string;
  completed: number;
};

function leaseEventRow(
  eventType: "agent.lease.expired" | "agent.task.reclaimed",
  row: {
    org_id: string;
    workspace_id: string;
    attempts: number;
    claimed_by: string | null;
  },
  payload: Record<string, unknown>,
): EventRow {
  return {
    event_id: crypto.randomUUID(),
    org_id: row.org_id,
    workspace_id: row.workspace_id,
    event_type: eventType,
    source_system: "inngest:agent.lease-sweep",
    stream_offset: null,
    payload: JSON.stringify({
      ...payload,
      attempts: Number(row.attempts),
      claimedBy: row.claimed_by,
    }),
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
        if (expired.length === 0)
          return { expired: [], requeued: [], failed: [] };

        const requeueIds = expired
          .filter((r) => decideSweepAction(Number(r.attempts)) === "requeue")
          .map((r) => r.id);
        const failIds = expired
          .filter((r) => decideSweepAction(Number(r.attempts)) === "fail")
          .map((r) => r.id);

        // Re-check the expiry in each UPDATE guard: a still-live worker may
        // have renewed between our SELECT and this write.
        if (requeueIds.length > 0) {
          await tx.execute(sql`
            UPDATE agent.subagent_runs
            SET status = 'pending', claimed_by = NULL, lease_expires_at = NULL, updated_at = now()
            WHERE id = ANY(${sql.param(requeueIds)}::uuid[])
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
            WHERE id = ANY(${sql.param(failIds)}::uuid[])
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
        if (expired.length === 0)
          return { expired: [], requeued: [], failed: [] };

        const requeueIds = expired
          .filter((r) => decideSweepAction(Number(r.attempts)) === "requeue")
          .map((r) => r.id);
        const failIds = expired
          .filter((r) => decideSweepAction(Number(r.attempts)) === "fail")
          .map((r) => r.id);

        if (requeueIds.length > 0) {
          await tx.execute(sql`
            UPDATE agent.agent_execution_steps
            SET status = 'pending', claimed_by = NULL, lease_expires_at = NULL, updated_at = now()
            WHERE id = ANY(${sql.param(requeueIds)}::uuid[])
              AND status = 'running' AND lease_expires_at < now()
          `);
        }
        if (failIds.length > 0) {
          await tx.execute(sql`
            UPDATE agent.agent_execution_steps
            SET status = 'failed',
                failure_reason = 'lease expired after ' || attempts || ' attempts',
                completed_at = now(), lease_expires_at = NULL, updated_at = now()
            WHERE id = ANY(${sql.param(failIds)}::uuid[])
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

    // ── 1c. Expired agent_runs (agent-engine v2 Phase 2 durable-run worker
    //       pool; docs/specs/agent-engine-v2/plan.md). Same requeue-below-cap
    //       / fail-at-cap idiom as 1a/1b. No dispatch event to re-emit here —
    //       the worker pool claims 'pending' rows by polling (claimNextRun in
    //       run-store.ts), unlike subagent_runs' event-driven fanout.
    //
    //       Nuance unique to this table: a row can be both lease-expired AND
    //       cancel_requested (the caller cancelled while the worker that held
    //       it had already died). That row must resolve to 'cancelled', not
    //       'pending' — requeuing it would let a run the caller gave up on
    //       resurrect and keep consuming budget unattended. So the SELECT
    //       snapshot is split into three buckets — cancel first, then
    //       requeue-vs-fail by attempt cap over what's left — each written by
    //       its own UPDATE, every one re-guarded on status/lease AND
    //       cancel_requested so a row that changed bucket between the SELECT
    //       and the write (e.g. a cancel request arriving mid-sweep) is left
    //       for the next tick instead of being clobbered into the wrong state.
    const agentRunSweep = await step.run("sweep-agent-runs", () =>
      withSystemDb(async (tx) => {
        const expired = (await tx.execute<ExpiredAgentRunRow>(sql`
          SELECT id, org_id, workspace_id, attempts, claimed_by, cancel_requested
          FROM agent.agent_runs
          WHERE status = 'running' AND lease_expires_at < now()
          ORDER BY lease_expires_at
          LIMIT ${SWEEP_BATCH_LIMIT}
          FOR UPDATE SKIP LOCKED
        `)) as unknown as ExpiredAgentRunRow[];
        if (expired.length === 0)
          return { expired: [], requeued: [], failed: [], cancelled: [] };

        const cancelIds = expired
          .filter((r) => r.cancel_requested)
          .map((r) => r.id);
        const live = expired.filter((r) => !r.cancel_requested);
        const requeueIds = live
          .filter(
            (r) =>
              decideSweepAction(Number(r.attempts), MAX_AGENT_RUN_ATTEMPTS) ===
              "requeue",
          )
          .map((r) => r.id);
        const failIds = live
          .filter(
            (r) =>
              decideSweepAction(Number(r.attempts), MAX_AGENT_RUN_ATTEMPTS) ===
              "fail",
          )
          .map((r) => r.id);

        // Re-check expiry (and cancel_requested) in each UPDATE guard: a
        // still-live worker may have renewed, or a cancel may have landed,
        // between our SELECT and this write.
        if (requeueIds.length > 0) {
          await tx.execute(sql`
            UPDATE agent.agent_runs
            SET status = 'pending', claimed_by = NULL, lease_expires_at = NULL, updated_at = now()
            WHERE id = ANY(${sql.param(requeueIds)}::uuid[])
              AND status = 'running' AND lease_expires_at < now() AND cancel_requested = false
          `);
        }
        if (failIds.length > 0) {
          await tx.execute(sql`
            UPDATE agent.agent_runs
            SET status = 'failed',
                error = 'lease expired after ' || attempts || ' attempts',
                completed_at = now(), lease_expires_at = NULL, updated_at = now()
            WHERE id = ANY(${sql.param(failIds)}::uuid[])
              AND status = 'running' AND lease_expires_at < now() AND cancel_requested = false
          `);
        }
        if (cancelIds.length > 0) {
          // A cancelled run is never a lease-expiry failure — no error, just
          // the terminal 'cancelled' status the caller asked for.
          await tx.execute(sql`
            UPDATE agent.agent_runs
            SET status = 'cancelled', error = NULL,
                completed_at = now(), lease_expires_at = NULL, updated_at = now()
            WHERE id = ANY(${sql.param(cancelIds)}::uuid[])
              AND status = 'running' AND lease_expires_at < now() AND cancel_requested = true
          `);
        }
        return {
          expired,
          requeued: expired.filter((r) => requeueIds.includes(r.id)),
          failed: expired.filter((r) => failIds.includes(r.id)),
          cancelled: expired.filter((r) => cancelIds.includes(r.id)),
        };
      }),
    );

    // ── 2a. Re-dispatch fanouts with requeued children ──────────────────────
    const fanoutEvents = new Map<
      string,
      { orgId: string; workspaceId: string; fanoutId: string }
    >();
    for (const r of runSweep.requeued) {
      fanoutEvents.set(r.fanout_id, {
        orgId: r.org_id,
        workspaceId: r.workspace_id,
        fanoutId: r.fanout_id,
      });
    }
    if (fanoutEvents.size > 0) {
      await step.sendEvent(
        "redispatch-fanouts",
        [...fanoutEvents.values()].map((data) => ({
          name: "agent/subagent.dispatch",
          data,
        })),
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
              outputFormat:
                typeof payload.outputFormat === "string"
                  ? payload.outputFormat
                  : "markdown",
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

        const finalized: (StuckFanoutRow & {
          finalStatus: "completed" | "failed" | "partial";
        })[] = [];
        for (const f of stuck) {
          const finalStatus = deriveFanoutStatus(
            Number(f.completed),
            Number(f.total),
            Number(f.failed) > 0,
          );
          // Same column mapping as the executor: the status CHECK has no
          // 'failed'; aggregate recomputes true 'failed' from per-run counts.
          const columnStatus =
            finalStatus === "failed" ? "partial" : finalStatus;
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
    const finalizedExecutions = await step.run(
      "finalize-stuck-executions",
      () =>
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

          const finalized: (StuckExecutionRow & {
            finalStatus: "completed" | "failed";
          })[] = [];
          for (const e of stuck) {
            // Same rule as agent.workflow.task.execute's finalize-execution.
            const finalStatus =
              Number(e.completed) > 0
                ? ("completed" as const)
                : ("failed" as const);
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
          leaseEventRow("agent.lease.expired", r, {
            kind: "subagent_run",
            runId: r.id,
            fanoutId: r.fanout_id,
          }),
        ),
        ...runSweep.requeued.map((r) =>
          leaseEventRow("agent.task.reclaimed", r, {
            kind: "subagent_run",
            runId: r.id,
            fanoutId: r.fanout_id,
          }),
        ),
        ...stepSweep.expired.map((r) =>
          leaseEventRow("agent.lease.expired", r, {
            kind: "execution_step",
            stepId: r.id,
            executionId: r.execution_id,
          }),
        ),
        ...stepSweep.requeued.map((r) =>
          leaseEventRow("agent.task.reclaimed", r, {
            kind: "execution_step",
            stepId: r.id,
            executionId: r.execution_id,
          }),
        ),
        // agent_runs: every expired row gets a lease.expired row (including
        // the cancelled ones — their lease genuinely did expire); only the
        // requeued subset counts as "reclaimed" — a cancelled row was not.
        ...agentRunSweep.expired.map((r) =>
          leaseEventRow("agent.lease.expired", r, {
            kind: "agent_run",
            runId: r.id,
          }),
        ),
        ...agentRunSweep.requeued.map((r) =>
          leaseEventRow("agent.task.reclaimed", r, {
            kind: "agent_run",
            runId: r.id,
          }),
        ),
      ];
      if (rows.length === 0) return;
      try {
        await insertEvents(rows);
      } catch (telErr) {
        logger.warn(
          { err: telErr },
          "insertEvents failed — lease telemetry loss",
        );
      }
    });

    // ── 5. Sweep expired agent file locks (docs/specs/agent-file-locking/plan.md
    //      §6) — reaps orphaned HOLDS_LOCK Neo4j edges left by a crashed/aborted
    //      turn. Lazy expiry (acquireFileLock's `l.expiresAt > $now` predicate)
    //      already makes an expired lock invisible to new acquires; this sweep
    //      only reclaims the graph rows so they don't accumulate forever. A
    //      Neo4j outage here must never fail the rest of this Postgres-backed
    //      sweep — best-effort, same fail-soft contract as the telemetry step.
    const fileLocksSwept = await step.run("sweep-file-locks", async () => {
      try {
        const { sweptCount } = await sweepExpiredFileLocks();
        return sweptCount;
      } catch (err) {
        logger.warn(
          { err },
          "sweepExpiredFileLocks failed — expired HOLDS_LOCK edges left for next sweep",
        );
        return 0;
      }
    });

    const summary = {
      runsRequeued: runSweep.requeued.length,
      runsFailedAtCap: runSweep.failed.length,
      stepsRequeued: stepSweep.requeued.length,
      stepsFailedAtCap: stepSweep.failed.length,
      agentRunsRequeued: agentRunSweep.requeued.length,
      agentRunsFailedAtCap: agentRunSweep.failed.length,
      agentRunsCancelled: agentRunSweep.cancelled.length,
      fanoutsFinalized: finalizedFanouts.length,
      executionsFinalized: finalizedExecutions.length,
      fileLocksSwept,
      maxAttempts: MAX_ATTEMPTS,
      maxAgentRunAttempts: MAX_AGENT_RUN_ATTEMPTS,
    };
    logger.info(summary, "agent.lease-sweep: sweep complete");
    return summary;
  },
);
