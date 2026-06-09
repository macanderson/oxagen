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
  outputPayload: unknown;
  errorReason: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
};

type FanoutRow = {
  publicId: string;
  status: string;
  totalChildren: number;
  completedChildren: number;
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

async function loadRuns(fanoutId: string, ctx: CapabilityContext): Promise<RunRow[]> {
  return withTenantDb((tx) =>
    tx
      .select({
        publicId: schema.subagentRuns.publicId,
        capabilityName: schema.subagentRuns.capabilityName,
        status: schema.subagentRuns.status,
        outputPayload: schema.subagentRuns.outputPayload,
        errorReason: schema.subagentRuns.errorReason,
        startedAt: schema.subagentRuns.startedAt,
        completedAt: schema.subagentRuns.completedAt,
      })
      .from(schema.subagentRuns)
      .where(
        and(
          eq(schema.subagentRuns.fanoutId, fanoutId),
          eq(schema.subagentRuns.orgId, ctx.orgId),
          eq(schema.subagentRuns.workspaceId, ctx.workspaceId),
        ),
      ),
  );
}

async function loadFanout(fanoutId: string, ctx: CapabilityContext): Promise<FanoutRow | null> {
  const [row] = await withTenantDb((tx) =>
    tx
      .select({
        publicId: schema.subagentFanouts.publicId,
        status: schema.subagentFanouts.status,
        totalChildren: schema.subagentFanouts.totalChildren,
        completedChildren: schema.subagentFanouts.completedChildren,
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

const POLL_INTERVAL_MS = 2_000;
const TERMINAL_STATUSES = new Set(["completed", "partial", "timed_out", "failed"]);

export async function agentSubagentAggregateHandler(
  input: AgentSubagentAggregateInput,
  ctx: CapabilityContext,
): Promise<AgentSubagentAggregateOutput> {
  const deadline = Date.now() + input.timeoutMs;

  // Poll until all children finish or timeout.
  let fanout: FanoutRow | null = null;
  while (true) {
    fanout = await loadFanout(input.fanoutId, ctx);
    if (!fanout) throw new Error(`Fanout ${input.fanoutId} not found`);

    if (TERMINAL_STATUSES.has(fanout.status)) break;

    if (Date.now() >= deadline) {
      const runs = await loadRuns(input.fanoutId, ctx);
      const timeline = runs.map((r) => ({
        runId: r.publicId,
        capabilityName: r.capabilityName,
        status: r.status,
        startedAt: r.startedAt ? r.startedAt.toISOString() : null,
        completedAt: r.completedAt ? r.completedAt.toISOString() : null,
        errorReason: r.errorReason,
      }));
      return {
        fanoutId: input.fanoutId,
        status: "timed_out",
        totalChildren: fanout.totalChildren,
        completedChildren: fanout.completedChildren,
        aggregatedData: null,
        conflicts: [],
        timeline,
        firstError: null,
      };
    }

    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  const runs = await loadRuns(input.fanoutId, ctx);
  const timeline = runs.map((r) => ({
    runId: r.publicId,
    capabilityName: r.capabilityName,
    status: r.status,
    startedAt: r.startedAt ? r.startedAt.toISOString() : null,
    completedAt: r.completedAt ? r.completedAt.toISOString() : null,
    errorReason: r.errorReason,
  }));

  const firstFailed = runs.find((r) => r.status === "failed");
  const firstError = firstFailed?.errorReason ?? null;

  // Any failed child → overall status is "failed" regardless of DB status.
  const effectiveStatus =
    firstFailed
      ? "failed"
      : (fanout.status as AgentSubagentAggregateOutput["status"]);

  if (effectiveStatus === "failed") {
    return {
      fanoutId: input.fanoutId,
      status: "failed",
      totalChildren: fanout.totalChildren,
      completedChildren: fanout.completedChildren,
      aggregatedData: null,
      conflicts: [],
      timeline,
      firstError,
    };
  }

  const { aggregatedData, conflicts } = mergeOutputs(runs);

  return {
    fanoutId: input.fanoutId,
    status: effectiveStatus,
    totalChildren: fanout.totalChildren,
    completedChildren: fanout.completedChildren,
    aggregatedData,
    conflicts,
    timeline,
    firstError: null,
  };
}
