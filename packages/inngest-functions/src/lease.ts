/**
 * Durable claim/lease primitives for fanout children and workflow steps
 * (docs/specs/graph-mediated-fanout-phase2 §1).
 *
 * Claiming is a single atomic UPDATE with a FOR UPDATE SKIP LOCKED subquery —
 * no separate SELECT, so there is no TOCTOU window and N concurrent executor
 * invocations for the same fanout cooperatively drain the queue instead of
 * double-running children. A claim takes a lease (default 10 min — children
 * may run long LLM calls); the executor renews it on a timer around the
 * invoke, and the agent.lease-sweep cron requeues expired-lease rows until
 * MAX_ATTEMPTS, after which they are failed. That attempt cap is what
 * guarantees every child eventually becomes terminal, keeping "fanout done"
 * a pure predicate over rows.
 */
import { withTenantDb } from "@oxagen/database";
import { sql } from "drizzle-orm";
import { runInTenantScope } from "@oxagen/tenancy";

/** A row is failed (not requeued) once it has been claimed this many times. */
export const MAX_ATTEMPTS = 3;

/** Lease window per claim. Long enough for a slow LLM call between renewals. */
export const LEASE_INTERVAL_SECONDS = 600;

/**
 * Renewal cadence while a child invoke is in flight — well under half the
 * lease window so one missed tick never expires a healthy worker's lease.
 */
export const LEASE_RENEW_INTERVAL_MS = 240_000;

export interface ClaimedSubagentRun {
  id: string;
  childMessageId: string;
  capabilityName: string;
  inputPayload: unknown;
  attempts: number;
}

type ClaimedSubagentRunRow = {
  id: string;
  child_message_id: string;
  capability_name: string;
  input_payload: unknown;
  attempts: number;
};

/**
 * Atomically claim the next runnable child of a fanout: a pending row, or a
 * running row whose lease has expired (dead worker). Returns null when the
 * queue is drained (or every remaining row is owned by a live worker /
 * exhausted). Rows at the attempt cap are left for the sweeper to fail.
 */
export async function claimNextSubagentRun(args: {
  orgId: string;
  workspaceId: string;
  fanoutId: string;
  workerId: string;
}): Promise<ClaimedSubagentRun | null> {
  return runInTenantScope(
    { orgId: args.orgId, workspaceId: args.workspaceId },
    () =>
      withTenantDb(async (tx) => {
        const rows = await tx.execute<ClaimedSubagentRunRow>(sql`
        UPDATE agent.subagent_runs SET
          status = 'running',
          claimed_by = ${args.workerId},
          attempts = attempts + 1,
          lease_expires_at = now() + make_interval(secs => ${LEASE_INTERVAL_SECONDS}),
          started_at = coalesce(started_at, now()),
          updated_at = now()
        WHERE id = (
          SELECT id FROM agent.subagent_runs
          WHERE fanout_id = ${args.fanoutId}::uuid
            AND org_id = ${args.orgId}::uuid
            AND attempts < ${MAX_ATTEMPTS}
            AND (status = 'pending' OR (status = 'running' AND lease_expires_at < now()))
          ORDER BY created_at
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id, child_message_id, capability_name, input_payload, attempts
      `);
        const row = (rows as unknown as ClaimedSubagentRunRow[])[0];
        if (!row) return null;
        return {
          id: row.id,
          childMessageId: row.child_message_id,
          capabilityName: row.capability_name,
          inputPayload: row.input_payload,
          attempts: Number(row.attempts),
        };
      }),
  );
}

/**
 * Extend the caller's lease on a claimed child. Guarded on claimed_by so a
 * worker whose row was reclaimed after a lease expiry cannot resurrect it.
 */
export async function renewSubagentRunLease(args: {
  orgId: string;
  workspaceId: string;
  runId: string;
  workerId: string;
}): Promise<void> {
  await runInTenantScope(
    { orgId: args.orgId, workspaceId: args.workspaceId },
    () =>
      withTenantDb((tx) =>
        tx.execute(sql`
        UPDATE agent.subagent_runs SET
          lease_expires_at = now() + make_interval(secs => ${LEASE_INTERVAL_SECONDS}),
          updated_at = now()
        WHERE id = ${args.runId}::uuid
          AND claimed_by = ${args.workerId}
          AND status = 'running'
      `),
      ),
  );
}

export interface ClaimedExecutionStep {
  id: string;
  attempts: number;
}

/**
 * Claim a specific workflow step (mark-running as a claim). Returns null when
 * the step is terminal, owned by a live worker, or at the attempt cap — the
 * caller must treat that as "someone else's work" and skip, which makes
 * duplicate event deliveries and sweeper re-dispatches safe.
 */
export async function claimExecutionStep(args: {
  orgId: string;
  workspaceId: string;
  stepId: string;
  workerId: string;
}): Promise<ClaimedExecutionStep | null> {
  return runInTenantScope(
    { orgId: args.orgId, workspaceId: args.workspaceId },
    () =>
      withTenantDb(async (tx) => {
        const rows = await tx.execute<{ id: string; attempts: number }>(sql`
        UPDATE agent.agent_execution_steps SET
          status = 'running',
          claimed_by = ${args.workerId},
          attempts = attempts + 1,
          lease_expires_at = now() + make_interval(secs => ${LEASE_INTERVAL_SECONDS}),
          started_at = coalesce(started_at, now()),
          updated_at = now()
        WHERE id = ${args.stepId}::uuid
          AND org_id = ${args.orgId}::uuid
          AND attempts < ${MAX_ATTEMPTS}
          AND (status = 'pending' OR (status = 'running' AND lease_expires_at < now()))
        RETURNING id, attempts
      `);
        const row = (rows as unknown as { id: string; attempts: number }[])[0];
        return row ? { id: row.id, attempts: Number(row.attempts) } : null;
      }),
  );
}

/** Extend the caller's lease on a claimed workflow step. */
export async function renewExecutionStepLease(args: {
  orgId: string;
  workspaceId: string;
  stepId: string;
  workerId: string;
}): Promise<void> {
  await runInTenantScope(
    { orgId: args.orgId, workspaceId: args.workspaceId },
    () =>
      withTenantDb((tx) =>
        tx.execute(sql`
        UPDATE agent.agent_execution_steps SET
          lease_expires_at = now() + make_interval(secs => ${LEASE_INTERVAL_SECONDS}),
          updated_at = now()
        WHERE id = ${args.stepId}::uuid
          AND claimed_by = ${args.workerId}
          AND status = 'running'
      `),
      ),
  );
}

/**
 * Start a background lease-renewal timer around a long-running invoke. The
 * returned stop() MUST be called in a finally block. Renewal failures are
 * swallowed (reported via onError) — a missed renewal only risks a benign
 * reclaim, which MAX_ATTEMPTS bounds; it must never fail the child itself.
 */
export function startLeaseRenewal(
  renew: () => Promise<void>,
  opts?: { intervalMs?: number; onError?: (err: unknown) => void },
): () => void {
  const timer = setInterval(() => {
    renew().catch((err: unknown) => opts?.onError?.(err));
  }, opts?.intervalMs ?? LEASE_RENEW_INTERVAL_MS);
  // Never hold the process open for a renewal timer.
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Sweep decision for an expired-lease row. Pure — exported for unit testing.
 * `attempts` counts claims already taken; below the cap the row gets another
 * chance, at or above it the row is failed terminally.
 */
export function decideSweepAction(
  attempts: number,
  maxAttempts: number = MAX_ATTEMPTS,
): "requeue" | "fail" {
  return attempts < maxAttempts ? "requeue" : "fail";
}
