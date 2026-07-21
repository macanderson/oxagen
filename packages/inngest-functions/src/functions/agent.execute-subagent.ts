import { createFunction } from "../create-function";
import { schema, withTenantDb } from "@oxagen/database";
import { eq, and, count, inArray, sql } from "drizzle-orm";
import { invoke } from "@oxagen/oxagen/kernel";
import { insertToolInvocation, insertEvents } from "@oxagen/telemetry";
import { runInTenantScope } from "@oxagen/tenancy";
import {
  claimNextSubagentRun,
  renewSubagentRunLease,
  startLeaseRenewal,
  type ClaimedSubagentRun,
} from "../lease";
import { logger } from "../logger";
import "@oxagen/oxagen";

/**
 * Structural ≤280-char digest of a child run's output, stored on
 * subagent_runs.summary so agent.subagent.aggregate can return summaries +
 * runId refs instead of relaying full payloads into the parent LLM context
 * (docs/specs/graph-mediated-fanout). Zero LLM cost by design:
 *   1. a top-level string `summary` / `message` / `text` field wins,
 *   2. else the JSON-serialized output truncated,
 *   3. else empty (failed runs store their errorReason instead).
 * 280 chars matches the CLI fleet's proven per-worker digest budget.
 * Pure helper — exported for unit testing.
 */
export const RUN_SUMMARY_MAX_CHARS = 280;

export function deriveRunSummary(output: unknown): string {
  if (
    output !== null &&
    output !== undefined &&
    typeof output === "object" &&
    !Array.isArray(output)
  ) {
    const record = output as Record<string, unknown>;
    for (const key of ["summary", "message", "text"] as const) {
      const value = record[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim().slice(0, RUN_SUMMARY_MAX_CHARS);
      }
    }
  }
  if (output === null || output === undefined) return "";
  try {
    const serialized = JSON.stringify(output);
    return typeof serialized === "string"
      ? serialized.slice(0, RUN_SUMMARY_MAX_CHARS)
      : "";
  } catch {
    return "";
  }
}

/** Pure helper — exported for unit testing. */
export function deriveFanoutStatus(
  completed: number,
  total: number,
  anyFailed: boolean,
): "completed" | "failed" | "partial" {
  if (completed === total) return "completed";
  if (anyFailed && completed === 0) return "failed";
  return "partial";
}

/**
 * Maximum subagent nesting depth (OXA-1498: infinite fanout guard).
 * Depth is carried in the Inngest event payload, NOT a DB column,
 * to avoid schema coupling. Default 0 (root dispatch), max 3 levels deep.
 */
const MAX_FANOUT_DEPTH = 3;

/**
 * Subagent fanout executor. Triggered by agent.subagent.dispatch via the
 * runtime's dispatchFanout(), and re-triggered by agent.lease-sweep when a
 * dead worker's children are requeued.
 *
 * Phase 2 (docs/specs/graph-mediated-fanout-phase2 §1): children are no
 * longer iterated positionally from a loaded list — the executor claim-loops
 * (`while (row = claim())`) over an atomic UPDATE … FOR UPDATE SKIP LOCKED,
 * so N concurrent invocations for the same fanout cooperatively drain the
 * queue instead of double-running children. Completion is decided from a
 * single DB count snapshot (not in-memory accumulators), because with claims
 * this run may have executed only a subset of the children; the last worker
 * to observe all-terminal finalizes, and a guarded finalize UPDATE dedupes
 * the completion event when two workers race that observation.
 *
 * OXA-1498:
 *   - Dispatches through kernel.invoke() so IAM enforcement, audit, and
 *     tool_invocations metering apply to every subagent capability call.
 *   - Depth guard: rejects fanouts that exceed MAX_FANOUT_DEPTH.
 */
export const [agentExecuteSubagent] = createFunction(
  {
    id: "agent.execute-subagent",
    retries: 0,
    concurrency: { limit: 5, key: "event.data.orgId" },
  },
  { event: "agent/subagent.dispatch" },
  async ({ event, step, runId }) => {
    const {
      orgId,
      workspaceId,
      fanoutId,
      depth: rawDepth,
    } = event.data as {
      orgId: string;
      workspaceId: string;
      fanoutId: string;
      depth?: number;
    };
    // Depth is optional for backwards-compatibility with events emitted before
    // the guard was added. Treat absence as depth 0 (root).
    const depth: number = typeof rawDepth === "number" ? rawDepth : 0;

    // Worker identity for claim ownership: the Inngest run id (stable across
    // step replays within this run; a sweeper re-dispatch is a new run and so
    // a new worker).
    const workerId =
      typeof runId === "string" && runId.length > 0
        ? runId
        : `worker:${fanoutId}`;

    // ── Depth guard ─────────────────────────────────────────────────────────
    if (depth > MAX_FANOUT_DEPTH) {
      logger.warn(
        { depth, fanoutId, orgId, maxFanoutDepth: MAX_FANOUT_DEPTH },
        "fanout depth exceeded — stopping to prevent infinite recursion",
      );
      return { fanoutId, completed: 0, status: "failed", depthExceeded: true };
    }

    // Only lift a non-terminal fanout to running — a stray re-dispatch must
    // never resurrect a finalized fanout.
    await step.run("mark-running", () =>
      runInTenantScope({ orgId, workspaceId }, () =>
        withTenantDb((tx) =>
          tx
            .update(schema.subagentFanouts)
            .set({ status: "running" })
            .where(
              and(
                eq(schema.subagentFanouts.id, fanoutId),
                eq(schema.subagentFanouts.orgId, orgId),
                inArray(schema.subagentFanouts.status, ["pending", "running"]),
              ),
            ),
        ),
      ),
    );

    // ── Claim loop ──────────────────────────────────────────────────────────
    let completedThisRun = 0;
    for (let claimIndex = 0; ; claimIndex++) {
      const claimed = (await step.run(`claim-${claimIndex}`, () =>
        claimNextSubagentRun({ orgId, workspaceId, fanoutId, workerId }),
      )) as ClaimedSubagentRun | null;
      if (!claimed) break;

      // Step id carries the attempt so a reclaimed child re-runs under a
      // fresh step instead of replaying a memoized result.
      const childOk = await step.run(
        `child-${claimed.id}-a${claimed.attempts}`,
        async () => {
          const invocationId = crypto.randomUUID();
          const startedAt = Date.now();
          const ctx = {
            orgId,
            workspaceId,
            userId: null,
            apiKeyId: null,
            requestId: claimed.childMessageId,
            surface: "runner" as const,
            messageId: claimed.childMessageId,
          };
          // Keep the lease alive across a long LLM call — a 10-min lease can
          // otherwise expire inside one invoke and trigger a false reclaim
          // (spec §Risks; MAX_ATTEMPTS makes even that converge).
          const stopRenewal = startLeaseRenewal(
            () =>
              renewSubagentRunLease({
                orgId,
                workspaceId,
                runId: claimed.id,
                workerId,
              }),
            {
              onError: (err) =>
                logger.warn(
                  { err, runId: claimed.id, fanoutId },
                  "lease renewal failed — sweeper may reclaim",
                ),
            },
          );
          try {
            // Route through kernel.invoke() for IAM enforcement, audit, and
            // uniform metering (OXA-1498 — previously bypassed via invokeCapability).
            // kernel.invoke() enters its own runInTenantScope internally (OXA-1515).
            // Transaction-span caution (spec §6.2): invoke may run a long LLM call;
            // keep withTenantDb blocks tight around DB-only work only.
            const output = await invoke(
              claimed.capabilityName,
              claimed.inputPayload,
              ctx,
            );
            const runSummary = deriveRunSummary(output);
            // Tight DB block: runs after the invoke completes, not wrapping it.
            // Terminal write releases the lease (null = unclaimed or terminal).
            await runInTenantScope({ orgId, workspaceId }, () =>
              withTenantDb((tx) =>
                tx
                  .update(schema.subagentRuns)
                  .set({
                    status: "completed",
                    outputPayload: (output ?? null) as object,
                    summary: runSummary,
                    completedAt: new Date(),
                    leaseExpiresAt: null,
                  })
                  .where(eq(schema.subagentRuns.id, claimed.id)),
              ),
            );
            // Write tool_invocations row for metering (OXA-1498).
            try {
              await insertToolInvocation({
                invocation_id: invocationId,
                org_id: orgId,
                workspace_id: workspaceId,
                capability_name: claimed.capabilityName,
                message_id: claimed.childMessageId,
                parent_message_id: fanoutId, // fanoutId is the closest parent we have here
                execution_step_id: null,
                status: "completed",
                input_size_bytes: 0,
                output_size_bytes: 0,
                latency_ms: Date.now() - startedAt,
                error_class: null,
                external_provider: "",
                external_server_id: null,
                risk_level: "low",
                required_approval: 0,
                surface: "runner",
                provider: "",
                created_at: new Date().toISOString(),
              });
            } catch (telErr) {
              logger.warn(
                { err: telErr },
                "insertToolInvocation failed — telemetry loss",
              );
            }
            return true;
          } catch (err) {
            const failureSummary = (
              err instanceof Error ? err.message : String(err)
            ).slice(0, RUN_SUMMARY_MAX_CHARS);
            // Tight DB block: runs after the invoke throws, not wrapping it.
            await runInTenantScope({ orgId, workspaceId }, () =>
              withTenantDb((tx) =>
                tx
                  .update(schema.subagentRuns)
                  .set({
                    status: "failed",
                    errorReason:
                      err instanceof Error ? err.message : String(err),
                    summary: failureSummary,
                    completedAt: new Date(),
                    leaseExpiresAt: null,
                  })
                  .where(eq(schema.subagentRuns.id, claimed.id)),
              ),
            );
            // Write failed tool_invocations row for metering.
            try {
              await insertToolInvocation({
                invocation_id: invocationId,
                org_id: orgId,
                workspace_id: workspaceId,
                capability_name: claimed.capabilityName,
                message_id: claimed.childMessageId,
                parent_message_id: fanoutId,
                execution_step_id: null,
                status: "failed",
                input_size_bytes: 0,
                output_size_bytes: 0,
                latency_ms: Date.now() - startedAt,
                error_class: err instanceof Error ? err.name : "UnknownError",
                external_provider: "",
                external_server_id: null,
                risk_level: "low",
                required_approval: 0,
                surface: "runner",
                provider: "",
                created_at: new Date().toISOString(),
              });
            } catch (telErr) {
              logger.warn(
                { err: telErr },
                "insertToolInvocation failed — telemetry loss",
              );
            }
            return false;
          } finally {
            stopRenewal();
          }
        },
      );
      if (childOk) completedThisRun++;
    }

    // ── Terminal check from one DB snapshot ─────────────────────────────────
    // A single aggregating query — the same one-snapshot rule as
    // agent.workflow.task.execute's count-steps: separate COUNTs at
    // independent READ COMMITTED snapshots can flip the terminal check.
    const counts = await step.run("count-runs", () =>
      runInTenantScope({ orgId, workspaceId }, () =>
        withTenantDb(async (tx) => {
          const [row] = await tx
            .select({
              total: count(schema.subagentRuns.id),
              completed: sql<number>`count(*) filter (where ${schema.subagentRuns.status} = 'completed')`,
              failed: sql<number>`count(*) filter (where ${schema.subagentRuns.status} = 'failed')`,
            })
            .from(schema.subagentRuns)
            .where(
              and(
                eq(schema.subagentRuns.fanoutId, fanoutId),
                eq(schema.subagentRuns.orgId, orgId),
              ),
            );
          return {
            total: Number(row?.total ?? 0),
            completed: Number(row?.completed ?? 0),
            failed: Number(row?.failed ?? 0),
          };
        }),
      ),
    );

    const { total, completed, failed } = counts ?? {
      total: 0,
      completed: 0,
      failed: 0,
    };

    if (completed + failed < total) {
      // Remaining children are owned by a live concurrent worker (or awaiting
      // a sweeper requeue). Whoever drains last finalizes.
      logger.info(
        { fanoutId, orgId, total, completed, failed, completedThisRun },
        "agent.execute-subagent: drained claim queue, fanout not yet terminal — leaving finalize to the last worker",
      );
      return { fanoutId, completed, status: "running" };
    }

    const finalStatus = deriveFanoutStatus(completed, total, failed > 0);
    // The subagent_fanouts.status CHECK constraint allows
    // {pending,running,completed,partial,timed_out} — not 'failed'. An
    // all-children-failed fanout is terminal-incomplete, so it is stored as
    // 'partial' at the column. Callers get the true 'failed' from
    // agent.subagent.aggregate, which recomputes status from per-run counts
    // (completedCount === 0 && anyFailed → 'failed').
    const columnStatus = finalStatus === "failed" ? "partial" : finalStatus;

    // Guarded finalize: only the worker that transitions the fanout out of a
    // non-terminal status emits completion telemetry + the completion event,
    // so two workers racing the all-terminal observation can't double-emit.
    const didFinalize = await step.run("finalize", () =>
      runInTenantScope({ orgId, workspaceId }, () =>
        withTenantDb(async (tx) => {
          const rows = await tx.execute<{ id: string }>(sql`
            UPDATE agent.subagent_fanouts
            SET status = ${columnStatus}, completed_children = ${completed}, updated_at = now()
            WHERE id = ${fanoutId}::uuid
              AND org_id = ${orgId}::uuid
              AND status IN ('pending', 'running')
            RETURNING id
          `);
          return (rows as unknown as { id: string }[]).length > 0;
        }),
      ),
    );

    if (!didFinalize) {
      return { fanoutId, completed, status: finalStatus };
    }

    // Fanout-completion telemetry → ClickHouse (shared analytics package).
    // Fire-and-forget; never fail the run on a telemetry write.
    await step.run("emit-completion-telemetry", async () => {
      try {
        // descendantCount (Phase 2 §4): the whole subtree below this fanout —
        // its own children plus any nested fanouts they dispatched — for the
        // depth/descendant scaling metrics and descendant-cap alerting.
        let descendantCount = total;
        try {
          const rows = await runInTenantScope({ orgId, workspaceId }, () =>
            withTenantDb((tx) =>
              tx.execute<{ descendant_count: number }>(sql`
                WITH RECURSIVE down AS (
                  SELECT r.id, r.child_message_id, 0 AS lvl
                  FROM agent.subagent_runs r
                  WHERE r.fanout_id = ${fanoutId}::uuid AND r.org_id = ${orgId}::uuid
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
            ),
          );
          descendantCount = Number(
            (rows as unknown as { descendant_count: number }[])[0]
              ?.descendant_count ?? total,
          );
        } catch (countErr) {
          logger.warn(
            { err: countErr, fanoutId },
            "descendant count failed — reporting direct children only",
          );
        }
        await insertEvents([
          {
            event_id: crypto.randomUUID(),
            org_id: orgId,
            workspace_id: workspaceId,
            event_type: "agent.subagent.fanout.completed",
            source_system: "inngest:agent.execute-subagent",
            stream_offset: null,
            payload: JSON.stringify({
              fanoutId,
              status: finalStatus,
              totalChildren: total,
              completedChildren: completed,
              depth,
              descendantCount,
            }),
            emitted_at: new Date().toISOString(),
          },
        ]);
      } catch (telErr) {
        logger.warn(
          { err: telErr, fanoutId },
          "insertEvents failed — fanout completion telemetry loss",
        );
      }
    });

    // Event-driven completion signal: lets agent.aggregate-fanout (and any
    // orchestrator) await the fanout via step.waitForEvent instead of polling.
    await step.sendEvent("fanout-completed", {
      name: "agent/subagent.fanout.completed",
      data: {
        orgId,
        workspaceId,
        fanoutId,
        status: finalStatus,
        completedChildren: completed,
        totalChildren: total,
      },
    });

    return { fanoutId, completed, status: finalStatus };
  },
);
