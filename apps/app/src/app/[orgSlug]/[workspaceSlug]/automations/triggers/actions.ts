"use server";
/**
 * automations/triggers/actions.ts — Server Actions for the workspace-wide
 * Triggers board.
 *
 * House pattern (see automations/actions.ts, the lead's template): zod
 * safeParse the client payload → resolveAutomationsScope (session/org/
 * workspace/IAM) → gate the mutation on `canManage` (workspace Owner/Admin —
 * apps/app does NOT bootstrap the IAM kernel, so this is THE authorization
 * gate) → call the typed agent.trigger.* helper in lib/automations/triggers.ts
 * → revalidate the Triggers route → return a discriminated union.
 *
 * toggleTriggerAction reuses the same mechanism as updateTriggerAction — the
 * agent.trigger.* family has no separate enable/disable capability like
 * automation.enable/automation.disable; Enable/Disable calls update_trigger
 * with the full existing trigger config and only `enabled` flipped. Kept as a
 * distinct action so the row menu's Enable/Disable click site stays
 * single-purpose and easy to find.
 */
import "@oxagen/handlers/register";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { logger } from "@oxagen/handlers/logger";
import { workspace } from "@/lib/routes";
import { resolveAutomationsScope } from "@/lib/automations/scope";
import { createTrigger, updateTrigger, deleteTrigger } from "@/lib/automations/triggers";
import type { TriggerConfig } from "@/lib/automations/triggers";
import type { AgentTriggerCreateOutput } from "@oxagen/oxagen/contracts/agent.trigger.create";
import type { AgentTriggerUpdateOutput } from "@oxagen/oxagen/contracts/agent.trigger.update";
import type { AgentTriggerDeleteOutput } from "@oxagen/oxagen/contracts/agent.trigger.delete";

export type TriggerActionResult<T = Record<string, never>> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

const MANAGE_DENIED = "Only workspace owners and admins can create, edit, or delete triggers.";

const scopeShape = {
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().min(1),
};

function revalidateTriggers(orgSlug: string, workspaceSlug: string): void {
  revalidatePath(workspace.automations.triggers({ orgSlug, workspaceSlug }));
}

// Mirrors agentEventFilterSchema / agentTriggerSchema
// (packages/oxagen/src/agent-schema.ts). Kept permissive here — the contract
// re-validates on invoke.
const eventFilterSchema = z.object({
  branches: z.array(z.string()).optional(),
  pathGlobs: z.array(z.string()).optional(),
  conditions: z.record(z.string(), z.unknown()).optional(),
});

const triggerConfigSchema = z.object({
  type: z.enum(["manual", "schedule", "event"]),
  eventSource: z.string().optional(),
  eventType: z.string().optional(),
  connectionId: z.string().optional(),
  filter: eventFilterSchema.optional(),
  schedule: z.string().optional(),
  enabled: z.boolean(),
});
export type TriggerConfigActionInput = z.input<typeof triggerConfigSchema>;

// ── Create ──────────────────────────────────────────────────────────────────

const createSchema = z.object({
  ...scopeShape,
  agentId: z.string().min(1),
  trigger: triggerConfigSchema,
});
export type CreateTriggerActionInput = z.input<typeof createSchema>;

export async function createTriggerAction(
  input: CreateTriggerActionInput,
): Promise<TriggerActionResult<{ trigger: AgentTriggerCreateOutput }>> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { orgSlug, workspaceSlug, agentId, trigger } = parsed.data;

  const { ctx, canManage } = await resolveAutomationsScope(orgSlug, workspaceSlug);
  if (!canManage) return { ok: false, error: MANAGE_DENIED };

  try {
    const result = await createTrigger(ctx, agentId, trigger as TriggerConfig);
    revalidateTriggers(orgSlug, workspaceSlug);
    return { ok: true, trigger: result };
  } catch (err) {
    logger.error(
      { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId, agentId },
      "triggers: createTriggerAction failed",
    );
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to create the trigger.",
    };
  }
}

// ── Update ──────────────────────────────────────────────────────────────────

const updateSchema = z.object({
  ...scopeShape,
  triggerId: z.string().min(1),
  trigger: triggerConfigSchema,
});
export type UpdateTriggerActionInput = z.input<typeof updateSchema>;

export async function updateTriggerAction(
  input: UpdateTriggerActionInput,
): Promise<TriggerActionResult<{ trigger: AgentTriggerUpdateOutput }>> {
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { orgSlug, workspaceSlug, triggerId, trigger } = parsed.data;

  const { ctx, canManage } = await resolveAutomationsScope(orgSlug, workspaceSlug);
  if (!canManage) return { ok: false, error: MANAGE_DENIED };

  try {
    const result = await updateTrigger(ctx, triggerId, trigger as TriggerConfig);
    revalidateTriggers(orgSlug, workspaceSlug);
    return { ok: true, trigger: result };
  } catch (err) {
    logger.error(
      { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId, triggerId },
      "triggers: updateTriggerAction failed",
    );
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to update the trigger.",
    };
  }
}

// ── Toggle (enable/disable) ─────────────────────────────────────────────────

export async function toggleTriggerAction(
  input: UpdateTriggerActionInput,
): Promise<TriggerActionResult<{ trigger: AgentTriggerUpdateOutput }>> {
  return updateTriggerAction(input);
}

// ── Delete ──────────────────────────────────────────────────────────────────

const deleteSchema = z.object({
  ...scopeShape,
  triggerId: z.string().min(1),
});
export type DeleteTriggerActionInput = z.input<typeof deleteSchema>;

export async function deleteTriggerAction(
  input: DeleteTriggerActionInput,
): Promise<TriggerActionResult<{ result: AgentTriggerDeleteOutput }>> {
  const parsed = deleteSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { orgSlug, workspaceSlug, triggerId } = parsed.data;

  const { ctx, canManage } = await resolveAutomationsScope(orgSlug, workspaceSlug);
  if (!canManage) return { ok: false, error: MANAGE_DENIED };

  try {
    const result = await deleteTrigger(ctx, triggerId);
    revalidateTriggers(orgSlug, workspaceSlug);
    return { ok: true, result };
  } catch (err) {
    logger.error(
      { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId, triggerId },
      "triggers: deleteTriggerAction failed",
    );
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to delete the trigger.",
    };
  }
}
