import { withTenantDb, schema } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import type { CapabilityContext } from "../types";
import {
  AGGREGATE_CHILD_OUTPUT_CAP_BYTES,
  AGGREGATE_MERGED_CAP_BYTES,
  type AgentSubagentAggregateInput,
  type AgentSubagentAggregateOutput,
} from "@oxagen/oxagen/contracts/agent.subagent.aggregate";
import { FanoutNotFoundError } from "./subagent-errors";
import {
  capPayload,
  fallbackRunSummary,
  payloadByteSize,
} from "./subagent-payload";

export type { AgentSubagentAggregateInput, AgentSubagentAggregateOutput };

type RunRow = {
  publicId: string;
  capabilityName: string;
  status: string;
  inputPayload: unknown;
  outputPayload: unknown;
  summary: string | null;
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
async function loadRuns(
  fanoutUuid: string,
  ctx: CapabilityContext,
): Promise<RunRow[]> {
  return withTenantDb((tx) =>
    tx
      .select({
        publicId: schema.subagentRuns.publicId,
        capabilityName: schema.subagentRuns.capabilityName,
        status: schema.subagentRuns.status,
        inputPayload: schema.subagentRuns.inputPayload,
        outputPayload: schema.subagentRuns.outputPayload,
        summary: schema.subagentRuns.summary,
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
async function loadFanout(
  fanoutId: string,
  ctx: CapabilityContext,
): Promise<FanoutRow | null> {
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
    // The executor (agent.execute-subagent) is what advances the fan-out row to
    // running/completed. If it never ran — e.g. the dispatch event was emitted
    // but no Inngest function picked it up (app not synced / signing-key
    // mismatch), or the emit failed and marked every child failed — the row is
    // stuck at `pending`. When every child has already reached a terminal state
    // we can report the true outcome immediately instead of waiting out the
    // snapshot window and reporting a misleading `running`/`timed_out`.
    const terminalCount = completedCount + failedCount;
    if (fanout.totalChildren > 0 && terminalCount >= fanout.totalChildren) {
      if (failedCount === 0) return "completed";
      if (completedCount === 0) return "failed";
      return "partial";
    }
    const ageMs = fanout.createdAt ? now - fanout.createdAt.getTime() : 0;
    return ageMs >= timeoutMs ? "timed_out" : "running";
  }
  if (fanout.status === "timed_out") return "timed_out";
  if (completedCount >= fanout.totalChildren && failedCount === 0)
    return "completed";
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
  // Typed error (not a plain Error) so surfaces can structurally map an unknown /
  // cross-tenant fanout id to a 404 instead of a 500 — and so an unrelated error
  // whose message merely contains "not found" is never misclassified as a 404.
  if (!fanout) throw new FanoutNotFoundError(input.fanoutId);

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

  // Per-child results. Compact by default: runId + summary + size — the full
  // payloads stay in Postgres and are fetched per-run via
  // agent.subagent.result.get when a summary is insufficient. This is the
  // token seam the spec kills: the old shape relayed every child's full
  // input+output into the parent LLM's context on every aggregate call
  // (docs/specs/graph-mediated-fanout).
  //
  // includeOutputs mode: attach full input + capped output to each entry,
  // for callers that post-process payloads server-side (research.swarm.status,
  // agent.subagent.logs), including while the fanout is still running
  // (progressive results).
  //
  // Compact mode while still running returns NO children at all — counts +
  // recheckAfterMs are all a caller can act on mid-flight; timeline still
  // carries live per-child status for viewers.
  const compactChildren =
    status === "running" && !input.includeOutputs
      ? []
      : runs.map((r) => {
          const base = {
            runId: r.publicId,
            capabilityName: r.capabilityName,
            status: r.status,
            summary:
              r.summary ?? fallbackRunSummary(r.outputPayload, r.errorReason),
            outputBytes: payloadByteSize(r.outputPayload),
            errorReason: r.errorReason,
          };
          if (!input.includeOutputs) return base;
          const capped = capPayload(
            r.outputPayload,
            AGGREGATE_CHILD_OUTPUT_CAP_BYTES,
          );
          return {
            ...base,
            input: r.inputPayload,
            output: capped.value,
            ...(capped.truncated ? { outputTruncated: true } : {}),
          };
        });

  // Merge only completed children's output. For an all-failed or still-running
  // fanout we never surface partial data as if usable — aggregatedData is null.
  // A "partial" fanout DOES return the merged output of the children that
  // succeeded, honestly labelled partial so callers never mistake it for done.
  // conflicts[] is always computed for mergeable states (cheap, server-side);
  // aggregatedData itself ships only when includeMerged asks for it AND the
  // merge fits the size cap — an oversized merge is flagged, not relayed.
  const canMerge = status === "completed" || status === "partial";
  const { aggregatedData: mergedData, conflicts } = canMerge
    ? mergeOutputs(runs)
    : {
        aggregatedData: null,
        conflicts: [] as AgentSubagentAggregateOutput["conflicts"],
      };
  const mergedOverCap =
    input.includeMerged &&
    mergedData !== null &&
    payloadByteSize(mergedData) > AGGREGATE_MERGED_CAP_BYTES;
  const aggregatedData =
    input.includeMerged && !mergedOverCap ? mergedData : null;

  return {
    fanoutId: input.fanoutId,
    status,
    totalChildren: fanout.totalChildren,
    // Live count derived from the child runs — NOT fanout.completedChildren,
    // which the executor only writes once in its final `finalize` step. Reading
    // the stale column made every in-flight poll report 0 completed, so the
    // research-swarm / workflow progress bars sat at 0% and only jumped at the
    // very end (the "progress bar never updates" bug). completedCount reflects
    // each child the moment its run row flips to "completed".
    completedChildren: completedCount,
    aggregatedData,
    aggregatedDataTruncated: mergedOverCap,
    conflicts,
    timeline,
    children: compactChildren,
    recheckAfterMs: status === "running" ? estimateRecheckMs(runs) : null,
    firstError,
  };
}

// Suggested wait before the next aggregate call while children are still
// executing: the median observed child duration, clamped to [5s, 60s]. With
// no completed child yet there is nothing to estimate — default 15s.
const RECHECK_DEFAULT_MS = 15_000;
const RECHECK_MIN_MS = 5_000;
const RECHECK_MAX_MS = 60_000;

function estimateRecheckMs(runs: RunRow[]): number {
  const durations = runs
    .filter((r) => r.status === "completed" && r.startedAt && r.completedAt)
    .map(
      (r) =>
        (r.completedAt as Date).getTime() - (r.startedAt as Date).getTime(),
    )
    .filter((ms) => ms > 0)
    .sort((a, b) => a - b);
  if (durations.length === 0) return RECHECK_DEFAULT_MS;
  const median = durations[Math.floor(durations.length / 2)]!;
  return Math.min(RECHECK_MAX_MS, Math.max(RECHECK_MIN_MS, Math.round(median)));
}
