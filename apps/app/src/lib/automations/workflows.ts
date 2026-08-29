/**
 * lib/automations/workflows.ts — typed server calls into the workflow.* and
 * research.swarm.* capability families via invoke(), for the Workflows &
 * swarms launch/monitor page.
 *
 * Mirrors the shape of lib/automations/automations.ts: thin wrappers that
 * parse input/output against the contract and dispatch through the kernel.
 * Each takes an already-resolved AutomationsCtx (from resolveAutomationsScope)
 * so the caller — a Server Action or an async RSC — owns the session/scope/IAM
 * gate.
 *
 * invoke() is called with NO `opts.surface` override: the kernel's surface
 * allowlist gate only fires when opts.surface is explicitly set (kernel.ts:578),
 * so omitting it lets ctx.surface="app" flow through for correct attribution
 * while the workflow.* / research.swarm.* contracts (which list "agent" but
 * not "app" in surfaces[]) are still reachable — the first-party app is a
 * trusted surface. Matches lib/automations/automations.ts and scope.ts.
 *
 * CONTRACT GAP — no workflow.list: agent.execution.list (list_executions) is
 * the only way to enumerate past workflow runs, and it does NOT filter by
 * originType, so listWorkflowRuns() filters client-side for
 * originType === "workflow_run". Its output also omits goal/title/sub-task
 * counts (those live in agent_executions.inputPayload, not exposed by the
 * contract) — so listWorkflowRuns() enriches only the newest ENRICH_LIMIT rows
 * via a bounded fan-out of get_workflow_status() calls; older rows render with
 * status/started/duration/cost only, and their goal/progress lives in the
 * per-row detail drawer (a single get_workflow_status call on open).
 *
 * CONTRACT GAP — no persistent swarm list: research.swarm.start does not
 * insert an agent_executions row (verified against
 * packages/handlers/src/research.swarm.start.ts — no agentExecutions insert),
 * so swarms have no server-side list surface at all. The Swarms tab tracks
 * launches client-side (sessionStorage) for the current browser session only;
 * see _components/swarm-session-store.ts.
 *
 * Server-only: imports the handler registry. Never import from a "use client"
 * module.
 */
import "@oxagen/handlers/register";
import type { z } from "zod";
import { invoke } from "@oxagen/oxagen";
import { workflowRun } from "@oxagen/oxagen/contracts/workflow.run";
import { workflowStatus } from "@oxagen/oxagen/contracts/workflow.status";
import { workflowCancel } from "@oxagen/oxagen/contracts/workflow.cancel";
import { researchSwarmStart } from "@oxagen/oxagen/contracts/research.swarm.start";
import { researchSwarmStatus } from "@oxagen/oxagen/contracts/research.swarm.status";
import { agentExecutionList } from "@oxagen/oxagen/contracts/agent.execution.list";
import type { WorkflowRunOutput } from "@oxagen/oxagen/contracts/workflow.run";
import type { WorkflowStatusOutput } from "@oxagen/oxagen/contracts/workflow.status";
import type { WorkflowCancelOutput } from "@oxagen/oxagen/contracts/workflow.cancel";
import type { ResearchSwarmStartOutput } from "@oxagen/oxagen/contracts/research.swarm.start";
import type { ResearchSwarmStatusOutput } from "@oxagen/oxagen/contracts/research.swarm.status";
import type { AutomationsCtx } from "./scope";

export type RunWorkflowArgs = z.input<typeof workflowRun.input>;
export type StartResearchSwarmArgs = z.input<typeof researchSwarmStart.input>;

/** Launch a new workflow run — decomposes `goal` into concurrent sub-tasks. */
export async function runWorkflow(
  ctx: AutomationsCtx,
  input: RunWorkflowArgs,
): Promise<WorkflowRunOutput> {
  const parsed = workflowRun.input.parse(input);
  const out = await invoke(workflowRun.name, parsed, ctx);
  return workflowRun.output.parse(out);
}

/** Read the live status + task list of one workflow run. */
export async function getWorkflowStatus(
  ctx: AutomationsCtx,
  workflowId: string,
): Promise<WorkflowStatusOutput> {
  const parsed = workflowStatus.input.parse({ workflowId });
  const out = await invoke(workflowStatus.name, parsed, ctx);
  return workflowStatus.output.parse(out);
}

/** Cancel a running or planning workflow. */
export async function cancelWorkflow(
  ctx: AutomationsCtx,
  workflowId: string,
): Promise<WorkflowCancelOutput> {
  const parsed = workflowCancel.input.parse({ workflowId });
  const out = await invoke(workflowCancel.name, parsed, ctx);
  return workflowCancel.output.parse(out);
}

/** Launch a research swarm — fans out diverse web-search variations. */
export async function startResearchSwarm(
  ctx: AutomationsCtx,
  input: StartResearchSwarmArgs,
): Promise<ResearchSwarmStartOutput> {
  const parsed = researchSwarmStart.input.parse(input);
  const out = await invoke(researchSwarmStart.name, parsed, ctx);
  return researchSwarmStart.output.parse(out);
}

/** Poll a research swarm's progress + collected results. */
export async function getResearchStatus(
  ctx: AutomationsCtx,
  swarmId: string,
): Promise<ResearchSwarmStatusOutput> {
  const parsed = researchSwarmStatus.input.parse({ swarmId });
  const out = await invoke(researchSwarmStatus.name, parsed, ctx);
  return researchSwarmStatus.output.parse(out);
}

/** One row of the Workflows table — base fields from agent.execution.list,
 *  optionally enriched with goal/title/sub-task counts from workflow.status. */
export interface WorkflowRunRow {
  executionId: string;
  status: "planning" | "running" | "completed" | "failed" | "cancelled";
  startedAt: string | null;
  completedAt: string | null;
  latencyMs: number | null;
  estimatedCostUsd: string | null;
  createdAt: string;
  /** Enriched fields — undefined for rows beyond ENRICH_LIMIT (contract gap). */
  title?: string;
  goal?: string;
  totalTasks?: number;
  completedTasks?: number;
  failedTasks?: number;
  enriched: boolean;
}

/** Bound on the get_workflow_status fan-out used to enrich list rows — keeps
 *  the page load to a handful of extra round-trips instead of N. */
const ENRICH_LIMIT = 10;
const LIST_LIMIT = 50;

/**
 * List workflow runs for the current workspace (newest first). Filters
 * agent.execution.list's output to originType === "workflow_run" (that
 * contract has no origin filter of its own — see the module-level contract
 * gap note) and enriches the newest ENRICH_LIMIT rows with goal/title/
 * sub-task counts via a bounded get_workflow_status fan-out.
 */
export async function listWorkflowRuns(
  ctx: AutomationsCtx,
): Promise<WorkflowRunRow[]> {
  const input = agentExecutionList.input.parse({ limit: LIST_LIMIT });
  const out = await invoke(agentExecutionList.name, input, ctx);
  const parsed = agentExecutionList.output.parse(out);
  const runs = parsed.executions.filter((e) => e.originType === "workflow_run");

  const toEnrich = runs.slice(0, ENRICH_LIMIT);
  const enrichedById = new Map<string, WorkflowStatusOutput>();
  await Promise.all(
    toEnrich.map(async (run) => {
      try {
        const detail = await getWorkflowStatus(ctx, run.executionId);
        enrichedById.set(run.executionId, detail);
      } catch (err) {
        // Best-effort enrichment — the row still renders with base fields.
        console.error("workflow.status enrichment failed:", err);
      }
    }),
  );

  return runs.map((run): WorkflowRunRow => {
    const detail = enrichedById.get(run.executionId);
    return {
      executionId: run.executionId,
      status: run.status,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      latencyMs: run.latencyMs,
      estimatedCostUsd: run.estimatedCostUsd,
      createdAt: run.createdAt,
      title: detail?.workflow.title,
      goal: detail?.workflow.goal,
      totalTasks: detail?.workflow.totalTasks,
      completedTasks: detail?.workflow.completedTasks,
      failedTasks: detail?.workflow.failedTasks,
      enriched: detail !== undefined,
    };
  });
}
