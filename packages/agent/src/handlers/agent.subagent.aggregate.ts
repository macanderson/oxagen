import { withTenantDb, schema } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import type { CapabilityContext } from "../types";
import type {
  AgentSubagentAggregateInput,
  AgentSubagentAggregateOutput,
} from "@oxagen/oxagen/contracts/agent.subagent.aggregate";

export type { AgentSubagentAggregateInput, AgentSubagentAggregateOutput };

type RunRow = {
  publicId: string;
  capabilityName: string;
  status: string;
  inputPayload: unknown;
  outputPayload: unknown;
  errorReason: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
};

type FanoutRow = {
  id: string;
  publicId: string;
  status: string;
  totalChildren: number;
  completedChildren: number;
  createdAt: Date | null;
};

// Merge all successful output payloads into one record. Where multiple runs
// set the same key to different values, record a conflict instead of overwriting.
function mergeOutputs(runs: RunRow[]): {
  aggregatedData: Record<string, unknown>;
  conflicts: AgentSubagentAggregateOutput["conflicts"];
} {
  const merged: Record<string, unknown> = {};
  // Track which values each key received and from which run.
  const keyMap: Record<string, { values: unknown[]; runIds: string[] }> = {};

  for (const run of runs) {
    if (run.status !== "completed" || run.outputPayload === null) continue;
    const payload =
      typeof run.outputPayload === "object" && run.outputPayload !== null
        ? (run.outputPayload as Record<string, unknown>)
        : {};
    for (const [k, v] of Object.entries(payload)) {
      const entry = keyMap[k];
      if (!entry) {
        keyMap[k] = { values: [v], runIds: [run.publicId] };
      } else {
        // Conflict when the new value is not deep-equal to any value seen so far.
        const isNew = !entry.values.some(
          (prior) => JSON.stringify(prior) === JSON.stringify(v),
        );
        if (isNew) {
          entry.values.push(v);
          entry.runIds.push(run.publicId);
        }
      }
    }
  }

  const conflicts: AgentSubagentAggregateOutput["conflicts"] = [];
  for (const [k, entry] of Object.entries(keyMap)) {
    if (entry.values.length > 1) {
      conflicts.push({ key: k, values: entry.values, runIds: entry.runIds });
    } else {
      merged[k] = entry.values[0];
    }
  }

  return { aggregatedData: merged, conflicts };
}

// fanoutUuid is the fan-out's internal uuid (subagent_fanouts.id), which is
// what subagent_runs.fanout_id stores — NOT the external public_id.
async function loadRuns(fanoutUuid: string, ctx: CapabilityContext): Promise<RunRow[]> {
  return withTenantDb((tx) =>
    tx
      .select({
        publicId: schema.subagentRuns.publicId,
        capabilityName: schema.subagentRuns.capabilityName,
        status: schema.subagentRuns.status,
        inputPayload: schema.subagentRuns.inputPayload,
        outputPayload: schema.subagentRuns.outputPayload,
        errorReason: schema.subagentRuns.errorReason,
        startedAt: schema.subagentRuns.startedAt,
        completedAt: schema.subagentRuns.completedAt,
      })
      .from(schema.subagentRuns)
      .where(
        and(
          eq(schema.subagentRuns.fanoutId, fanoutUuid),
          eq(schema.subagentRuns.orgId, ctx.orgId),
          eq(schema.subagentRuns.workspaceId, ctx.workspaceId),
        ),
      ),
  );
}

// The fanoutId argument here is the external public_id (the dispatchId callers
// receive from agent.subagent.dispatch); we look the fan-out up by public_id.
async function loadFanout(fanoutId: string, ctx: CapabilityContext): Promise<FanoutRow | null> {
  const [row] = await withTenantDb((tx) =>
    tx
      .select({
        id: schema.subagentFanouts.id,
        publicId: schema.subagentFanouts.publicId,
        status: schema.subagentFanouts.status,
        totalChildren: schema.subagentFanouts.totalChildren,
        completedChildren: schema.subagentFanouts.completedChildren,
        createdAt: schema.subagentFanouts.createdAt,
      })
      .from(schema.subagentFanouts)
      .where(
        and(
          eq(schema.subagentFanouts.publicId, fanoutId),
          eq(schema.subagentFanouts.orgId, ctx.orgId),
          eq(schema.subagentFanouts.workspaceId, ctx.workspaceId),
        ),
      )
      .limit(1),
  );
  return row ?? null;
}

// In-progress (non-terminal) fanout states written by agent.execute-subagent.
const IN_PROGRESS_STATUSES = new Set(["pending", "running"]);

type AggStatus = AgentSubagentAggregateOutput["status"];

/**
 * Derive the honest aggregate status from the current snapshot — never a poll.
 *
 * OXA: the old handler busy-waited a 2s poll for up to 30 min, which exhausts
 * the serverless function timeout, and collapsed every failure into "failed"
 * while reporting still-running fanouts as terminal. This is a non-blocking
 * snapshot: callers (or the agent.aggregate-fanout Inngest function via
 * step.waitForEvent) decide when to read; we report exactly what is true now.
 *
 *   - pending/running, within the snapshot window → "running"
 *   - pending/running, older than timeoutMs        → "timed_out"
 *   - all children completed, none failed          → "completed"
 *   - zero completed, at least one failed          → "failed"
 *   - a mix of completed and failed/incomplete     → "partial" (distinct!)
 */
function deriveAggregateStatus(
  fanout: FanoutRow,
  completedCount: number,
  failedCount: number,
  timeoutMs: number,
  now: number,
): AggStatus {
  if (IN_PROGRESS_STATUSES.has(fanout.status)) {
    const ageMs = fanout.createdAt ? now - fanout.createdAt.getTime() : 0;
    return ageMs >= timeoutMs ? "timed_out" : "running";
  }
  if (fanout.status === "timed_out") return "timed_out";
  if (completedCount >= fanout.totalChildren && failedCount === 0) return "completed";
  if (completedCount === 0 && failedCount > 0) return "failed";
  return "partial";
}

export async function agentSubagentAggregateHandler(
  input: AgentSubagentAggregateInput,
  ctx: CapabilityContext,
): Promise<AgentSubagentAggregateOutput> {
  // Single, non-blocking read of the current fanout + child snapshot. No poll,
  // no setTimeout — safe within a serverless function budget. Durable waiting,
  // when a caller needs to block until completion, lives in the
  // agent.aggregate-fanout Inngest function (step.waitForEvent).
  const fanout = await loadFanout(input.fanoutId, ctx);
  if (!fanout) throw new Error(`Fanout ${input.fanoutId} not found`);

  // Child runs are keyed by the fan-out's uuid, not its public_id.
  const runs = await loadRuns(fanout.id, ctx);
  const timeline = runs.map((r) => ({
    runId: r.publicId,
    capabilityName: r.capabilityName,
    status: r.status,
    startedAt: r.startedAt ? r.startedAt.toISOString() : null,
    completedAt: r.completedAt ? r.completedAt.toISOString() : null,
    errorReason: r.errorReason,
  }));

  // Per-child raw results — full input + output, NOT merged. This is what lets
  // research.swarm.status surface each query's hits instead of a collapsed blob.
  const children = runs.map((r) => ({
    runId: r.publicId,
    capabilityName: r.capabilityName,
    status: r.status,
    input: r.inputPayload,
    output: r.outputPayload,
    errorReason: r.errorReason,
  }));

  const completedCount = runs.filter((r) => r.status === "completed").length;
  const failedRuns = runs.filter((r) => r.status === "failed");
  const firstError = failedRuns[0]?.errorReason ?? null;

  const status = deriveAggregateStatus(
    fanout,
    completedCount,
    failedRuns.length,
    input.timeoutMs,
    Date.now(),
  );

  // Merge only completed children's output. For an all-failed or still-running
  // fanout we never surface partial data as if usable — aggregatedData is null.
  // A "partial" fanout DOES return the merged output of the children that
  // succeeded, honestly labelled partial so callers never mistake it for done.
  const canMerge = status === "completed" || status === "partial";
  const { aggregatedData, conflicts } = canMerge
    ? mergeOutputs(runs)
    : { aggregatedData: null, conflicts: [] as AgentSubagentAggregateOutput["conflicts"] };

  return {
    fanoutId: input.fanoutId,
    status,
    totalChildren: fanout.totalChildren,
    completedChildren: fanout.completedChildren,
    aggregatedData,
    conflicts,
    timeline,
    children,
    firstError,
  };
}
