import { createFunction } from "../create-function";
import { schema, withTenantDb } from "@oxagen/database";
import { eq, and } from "drizzle-orm";
import { invoke } from "@oxagen/oxagen/kernel";
import { insertToolInvocation, insertEvents } from "@oxagen/telemetry";
import { runInTenantScope } from "@oxagen/tenancy";
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
  if (output !== null && output !== undefined && typeof output === "object" && !Array.isArray(output)) {
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
    return typeof serialized === "string" ? serialized.slice(0, RUN_SUMMARY_MAX_CHARS) : "";
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
 * runtime's dispatchFanout(). Each child runs in its own step.run so
 * Inngest checkpoints around it; we never bail the whole fanout on one
 * child failure — the parent message aggregates partials.
 *
 * OXA-1498:
 *   - Dispatches through kernel.invoke() so IAM enforcement, audit, and
 *     tool_invocations metering apply to every subagent capability call.
 *   - Depth guard: rejects fanouts that exceed MAX_FANOUT_DEPTH.
 */
export const [agentExecuteSubagent] = createFunction(
  { id: "agent.execute-subagent", retries: 0, concurrency: { limit: 5, key: "event.data.orgId" } },
  { event: "agent/subagent.dispatch" },
  async ({ event, step }) => {
    const { orgId, workspaceId, fanoutId, depth: rawDepth } = event.data as {
      orgId: string;
      workspaceId: string;
      fanoutId: string;
      depth?: number;
    };
    // Depth is optional for backwards-compatibility with events emitted before
    // the guard was added. Treat absence as depth 0 (root).
    const depth: number = typeof rawDepth === "number" ? rawDepth : 0;

    // ── Depth guard ─────────────────────────────────────────────────────────
    if (depth > MAX_FANOUT_DEPTH) {
      logger.warn({ depth, fanoutId, orgId, maxFanoutDepth: MAX_FANOUT_DEPTH }, 'fanout depth exceeded — stopping to prevent infinite recursion');
      return { fanoutId, completed: 0, status: "failed", depthExceeded: true };
    }

    const runs = await step.run("load-children", () =>
      runInTenantScope({ orgId, workspaceId }, () =>
        withTenantDb((tx) =>
          tx
            .select()
            .from(schema.subagentRuns)
            .where(
              and(eq(schema.subagentRuns.fanoutId, fanoutId), eq(schema.subagentRuns.orgId, orgId)),
            ),
        ),
      ),
    );

    await step.run("mark-running", () =>
      runInTenantScope({ orgId, workspaceId }, () =>
        withTenantDb((tx) =>
          tx
            .update(schema.subagentFanouts)
            .set({ status: "running" })
            .where(eq(schema.subagentFanouts.id, fanoutId)),
        ),
      ),
    );

    let completed = 0;
    let anyFailed = false;
    for (const r of runs) {
      const childOk = await step.run(`child-${r.id}`, async () => {
        const invocationId = crypto.randomUUID();
        const startedAt = Date.now();
        const ctx = {
          orgId,
          workspaceId,
          userId: null,
          apiKeyId: null,
          requestId: r.childMessageId,
          surface: "runner" as const,
          messageId: r.childMessageId,
        };
        try {
          // Stamp the run as started BEFORE the invoke so timeline/durationMs
          // (and aggregate's recheckAfterMs estimate) reflect real per-child
          // timing — previously startedAt was never written and every child sat
          // at 'pending' until it finished.
          await runInTenantScope({ orgId, workspaceId }, () =>
            withTenantDb((tx) =>
              tx
                .update(schema.subagentRuns)
                .set({ status: "running", startedAt: new Date() })
                .where(eq(schema.subagentRuns.id, r.id)),
            ),
          );
          // Route through kernel.invoke() for IAM enforcement, audit, and
          // uniform metering (OXA-1498 — previously bypassed via invokeCapability).
          // kernel.invoke() enters its own runInTenantScope internally (OXA-1515).
          // Transaction-span caution (spec §6.2): invoke may run a long LLM call;
          // keep withTenantDb blocks tight around DB-only work only.
          const output = await invoke(r.capabilityName, r.inputPayload, ctx);
          // Tight DB block: runs after the invoke completes, not wrapping it.
          await runInTenantScope({ orgId, workspaceId }, () =>
            withTenantDb((tx) =>
              tx
                .update(schema.subagentRuns)
                .set({
                  status: "completed",
                  outputPayload: (output ?? null) as object,
                  summary: deriveRunSummary(output),
                  completedAt: new Date(),
                })
                .where(eq(schema.subagentRuns.id, r.id)),
            ),
          );
          // Write tool_invocations row for metering (OXA-1498).
          try {
            await insertToolInvocation({
              invocation_id: invocationId,
              org_id: orgId,
              workspace_id: workspaceId,
              capability_name: r.capabilityName,
              message_id: r.childMessageId,
              parent_message_id: r.fanoutId, // fanoutId is the closest parent we have here
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
            logger.warn({ err: telErr }, 'insertToolInvocation failed — telemetry loss');
          }
          return true;
        } catch (err) {
          // Tight DB block: runs after the invoke throws, not wrapping it.
          await runInTenantScope({ orgId, workspaceId }, () =>
            withTenantDb((tx) =>
              tx
                .update(schema.subagentRuns)
                .set({
                  status: "failed",
                  errorReason: err instanceof Error ? err.message : String(err),
                  summary: (err instanceof Error ? err.message : String(err)).slice(0, RUN_SUMMARY_MAX_CHARS),
                  completedAt: new Date(),
                })
                .where(eq(schema.subagentRuns.id, r.id)),
            ),
          );
          // Write failed tool_invocations row for metering.
          try {
            await insertToolInvocation({
              invocation_id: invocationId,
              org_id: orgId,
              workspace_id: workspaceId,
              capability_name: r.capabilityName,
              message_id: r.childMessageId,
              parent_message_id: r.fanoutId,
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
            logger.warn({ err: telErr }, 'insertToolInvocation failed — telemetry loss');
          }
          return false;
        }
      });
      if (childOk) completed++;
      else anyFailed = true;
    }

    const finalStatus = deriveFanoutStatus(completed, runs.length, anyFailed);
    // The subagent_fanouts.status CHECK constraint allows
    // {pending,running,completed,partial,timed_out} — not 'failed'. An
    // all-children-failed fanout is terminal-incomplete, so it is stored as
    // 'partial' at the column. Callers get the true 'failed' from
    // agent.subagent.aggregate, which recomputes status from per-run counts
    // (completedCount === 0 && anyFailed → 'failed').
    const columnStatus = finalStatus === "failed" ? "partial" : finalStatus;
    await step.run("finalize", () =>
      runInTenantScope({ orgId, workspaceId }, () =>
        withTenantDb((tx) =>
          tx
            .update(schema.subagentFanouts)
            .set({ status: columnStatus, completedChildren: completed })
            .where(
              and(eq(schema.subagentFanouts.id, fanoutId), eq(schema.subagentFanouts.orgId, orgId)),
            ),
        ),
      ),
    );

    // Fanout-completion telemetry → ClickHouse (shared analytics package).
    // Previously no event was emitted on fanout completion, so fanout cost and
    // throughput were invisible. Fire-and-forget; never fail the run on a
    // telemetry write.
    await step.run("emit-completion-telemetry", async () => {
      try {
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
              totalChildren: runs.length,
              completedChildren: completed,
              depth,
            }),
            emitted_at: new Date().toISOString(),
          },
        ]);
      } catch (telErr) {
        logger.warn({ err: telErr, fanoutId }, "insertEvents failed — fanout completion telemetry loss");
      }
    });

    // Event-driven completion signal: lets agent.aggregate-fanout (and any
    // orchestrator) await the fanout via step.waitForEvent instead of polling.
    await step.sendEvent("fanout-completed", {
      name: "agent/subagent.fanout.completed",
      data: { orgId, workspaceId, fanoutId, status: finalStatus, completedChildren: completed, totalChildren: runs.length },
    });

    return { fanoutId, completed, status: finalStatus };
  },
);
