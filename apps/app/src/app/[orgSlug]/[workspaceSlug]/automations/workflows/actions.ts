"use server";
/**
 * automations/workflows/actions.ts — Server Actions for the Workflows &
 * swarms launch/monitor page.
 *
 * House pattern (see automations/actions.ts): zod safeParse the client
 * payload → resolveAutomationsScope (session/org/workspace/IAM) → gate the
 * mutation on `canManage` (workspace Owner/Admin — apps/app does NOT
 * bootstrap the IAM kernel, so this is THE authorization gate for calls made
 * through this page) → call the typed workflow / research-swarm helper →
 * revalidate → return a discriminated union so the client can render the
 * capability's own validation error inline instead of a generic toast.
 *
 * startResearchSwarmAction does NOT revalidatePath: research.swarm.start has
 * no persistent list surface (see the contract-gap note in
 * lib/automations/workflows.ts) — the launch dialog hands the swarm result
 * straight to client-side session tracking instead.
 */
import "@oxagen/handlers/register";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { logger } from "@oxagen/handlers/logger";
import { workspace } from "@/lib/routes";
import { resolveAutomationsScope } from "@/lib/automations/scope";
import {
  runWorkflow,
  cancelWorkflow,
  startResearchSwarm,
} from "@/lib/automations/workflows";
import type { WorkflowRunOutput } from "@oxagen/oxagen/contracts/workflow.run";
import type { WorkflowCancelOutput } from "@oxagen/oxagen/contracts/workflow.cancel";
import type { ResearchSwarmStartOutput } from "@oxagen/oxagen/contracts/research.swarm.start";

export type WorkflowActionResult<T = Record<string, never>> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

const MANAGE_DENIED =
  "Only workspace owners and admins can launch or cancel workflows and research swarms.";

const scopeShape = {
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().min(1),
};

function revalidateWorkflows(orgSlug: string, workspaceSlug: string): void {
  revalidatePath(workspace.automations.workflows({ orgSlug, workspaceSlug }));
}

// ── Launch workflow ────────────────────────────────────────────────────────

// Mirrors workflow.run's contract bounds (goal ≤2000, title ≤200, maxParallelism
// 1-100) so an out-of-bounds submission is rejected here, inline, before ever
// reaching invoke().
const runWorkflowSchema = z.object({
  ...scopeShape,
  goal: z.string().min(1).max(2000),
  title: z.string().min(1).max(200).optional(),
  outputFormat: z.enum(["json", "csv"]).default("json"),
  maxParallelism: z.number().int().min(1).max(100).default(50),
});
export type RunWorkflowActionInput = z.input<typeof runWorkflowSchema>;

export async function runWorkflowAction(
  input: RunWorkflowActionInput,
): Promise<WorkflowActionResult<{ workflow: WorkflowRunOutput }>> {
  const parsed = runWorkflowSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }
  const { orgSlug, workspaceSlug, goal, title, outputFormat, maxParallelism } =
    parsed.data;

  const { ctx, canManage } = await resolveAutomationsScope(
    orgSlug,
    workspaceSlug,
  );
  if (!canManage) return { ok: false, error: MANAGE_DENIED };

  try {
    const workflow = await runWorkflow(ctx, {
      goal,
      title,
      outputFormat,
      maxParallelism,
    });
    revalidateWorkflows(orgSlug, workspaceSlug);
    return { ok: true, workflow };
  } catch (err) {
    logger.error(
      { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      "workflows: runWorkflowAction failed",
    );
    return {
      ok: false,
      error:
        err instanceof Error ? err.message : "Failed to launch the workflow.",
    };
  }
}

// ── Cancel workflow ────────────────────────────────────────────────────────

const cancelWorkflowSchema = z.object({
  ...scopeShape,
  workflowId: z.string().min(1),
});

export async function cancelWorkflowAction(
  input: z.input<typeof cancelWorkflowSchema>,
): Promise<WorkflowActionResult<{ result: WorkflowCancelOutput }>> {
  const parsed = cancelWorkflowSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }
  const { orgSlug, workspaceSlug, workflowId } = parsed.data;

  const { ctx, canManage } = await resolveAutomationsScope(
    orgSlug,
    workspaceSlug,
  );
  if (!canManage) return { ok: false, error: MANAGE_DENIED };

  try {
    const result = await cancelWorkflow(ctx, workflowId);
    revalidateWorkflows(orgSlug, workspaceSlug);
    return { ok: true, result };
  } catch (err) {
    logger.error(
      { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId, workflowId },
      "workflows: cancelWorkflowAction failed",
    );
    return {
      ok: false,
      error:
        err instanceof Error ? err.message : "Failed to cancel the workflow.",
    };
  }
}

// ── Launch research swarm ─────────────────────────────────────────────────

// Mirrors research.swarm.start's contract bounds (topic ≤500, maxParallel
// 1-20).
const startSwarmSchema = z.object({
  ...scopeShape,
  topic: z.string().min(1).max(500),
  depth: z.enum(["shallow", "medium", "deep"]).default("medium"),
  maxParallel: z.number().int().min(1).max(20).default(5),
  targetLabel: z.string().min(1).default("Topic"),
  searchDepth: z.enum(["basic", "advanced"]).optional(),
});
export type StartResearchSwarmActionInput = z.input<typeof startSwarmSchema>;

export async function startResearchSwarmAction(
  input: StartResearchSwarmActionInput,
): Promise<WorkflowActionResult<{ swarm: ResearchSwarmStartOutput }>> {
  const parsed = startSwarmSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }
  const {
    orgSlug,
    workspaceSlug,
    topic,
    depth,
    maxParallel,
    targetLabel,
    searchDepth,
  } = parsed.data;

  const { ctx, canManage } = await resolveAutomationsScope(
    orgSlug,
    workspaceSlug,
  );
  if (!canManage) return { ok: false, error: MANAGE_DENIED };

  try {
    const swarm = await startResearchSwarm(ctx, {
      topic,
      depth,
      maxParallel,
      targetLabel,
      searchDepth,
    });
    // No revalidatePath — see the module doc: swarms have no persistent list.
    return { ok: true, swarm };
  } catch (err) {
    logger.error(
      { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      "workflows: startResearchSwarmAction failed",
    );
    return {
      ok: false,
      error:
        err instanceof Error
          ? err.message
          : "Failed to start the research swarm.",
    };
  }
}
