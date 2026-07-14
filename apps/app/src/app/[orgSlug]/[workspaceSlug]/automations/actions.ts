"use server";
/**
 * automations/actions.ts — Server Actions for the Automations list + editor.
 *
 * House pattern (see workbench/agents/actions.ts): zod safeParse the client
 * payload → resolveAutomationsScope (session/org/workspace/IAM) → gate the
 * mutation on `canManage` (workspace Owner/Admin — apps/app does NOT bootstrap
 * the IAM kernel, so this is THE authorization gate) → call the typed
 * automation.* helper → revalidate the surface → return a discriminated union.
 *
 * enable is the human gate: it is a plain Server Action reachable only from a
 * direct human click behind the confirm dialog — never an agent-rendered
 * surface (that path is the chat inline component, a distinct code path).
 */
import "@oxagen/handlers/register";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { logger } from "@oxagen/handlers/logger";
import { conditionTreeSchema } from "@oxagen/oxagen/trigger-conditions";
import { workspace } from "@/lib/routes";
import { resolveAutomationsScope } from "@/lib/automations/scope";
import {
  createAutomation,
  enableAutomation,
  disableAutomation,
  triggerAutomation,
  updateAutomation,
} from "@/lib/automations/automations";
import type { AutomationCreateOutput } from "@oxagen/oxagen/contracts/automation.create";
import type { AutomationEnableOutput } from "@oxagen/oxagen/contracts/automation.enable";
import type { AutomationDisableOutput } from "@oxagen/oxagen/contracts/automation.disable";
import type { AutomationTriggerOutput } from "@oxagen/oxagen/contracts/automation.trigger";
import type { AutomationUpdateOutput } from "@oxagen/oxagen/contracts/automation.update";

export type AutomationActionResult<T = Record<string, never>> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

const MANAGE_DENIED =
  "Only workspace owners and admins can create, enable, or run automations.";

const scopeShape = {
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().min(1),
};

function revalidateAutomations(orgSlug: string, workspaceSlug: string): void {
  revalidatePath(workspace.automations.root({ orgSlug, workspaceSlug }));
}

// ── Create ──────────────────────────────────────────────────────────────────

// Trigger-config subschema mirrors automation.create.triggerConfig (event +
// schedule fields). Kept permissive here — the contract re-validates on invoke.
const propertyConditionSchema = z.object({
  property: z.string().min(1),
  operator: z.enum(["eq", "gt", "lt", "changed"]).default("eq"),
  toValue: z.string().optional(),
});
const triggerConfigSchema = z.object({
  entityType: z.string().optional(),
  eventType: z
    .enum(["node.created", "node.updated", "node.deleted"])
    .optional(),
  // Nested schema-driven condition tree (preferred). The full validator (depth
  // guard + leaf/group shape) is reused from the shared trigger-conditions
  // module; the contract re-validates on invoke.
  conditionTree: conditionTreeSchema.optional(),
  propertyConditions: z.array(propertyConditionSchema).optional(),
  cronExpression: z.string().optional(),
  timezone: z.string().optional(),
});
const stepSchema = z.object({
  name: z.string().min(1),
  stepType: z.enum([
    "agent",
    "tool",
    "condition",
    "webhook",
    "prompt",
    "human_input",
  ]),
  config: z.record(z.unknown()).optional(),
});

const createSchema = z.object({
  ...scopeShape,
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  triggerType: z.enum(["event", "schedule", "api"]),
  triggerConfig: triggerConfigSchema.optional(),
  steps: z.array(stepSchema).optional(),
});
export type CreateAutomationActionInput = z.input<typeof createSchema>;

export async function createAutomationAction(
  input: CreateAutomationActionInput,
): Promise<AutomationActionResult<{ automation: AutomationCreateOutput }>> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }
  const {
    orgSlug,
    workspaceSlug,
    name,
    description,
    triggerType,
    triggerConfig,
    steps,
  } = parsed.data;

  const { ctx, canManage } = await resolveAutomationsScope(
    orgSlug,
    workspaceSlug,
  );
  if (!canManage) return { ok: false, error: MANAGE_DENIED };

  try {
    // Always create disabled (enabled:false) and let the human flip it live via
    // the human-gated enable, keeping a single activation path through the gate.
    const automation = await createAutomation(ctx, {
      name,
      description,
      triggerType,
      triggerConfig: triggerConfig ?? {},
      steps: steps ?? [],
      enabled: false,
    });
    revalidateAutomations(orgSlug, workspaceSlug);
    return { ok: true, automation };
  } catch (err) {
    logger.error(
      { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      "automations: createAutomationAction failed",
    );
    return {
      ok: false,
      error:
        err instanceof Error ? err.message : "Failed to create the automation.",
    };
  }
}

// ── Enable (human gate) ───────────────────────────────────────────────────────

const idSchema = z.object({ ...scopeShape, automationId: z.string().min(1) });

export async function enableAutomationAction(
  input: z.input<typeof idSchema>,
): Promise<AutomationActionResult<{ result: AutomationEnableOutput }>> {
  const parsed = idSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }
  const { orgSlug, workspaceSlug, automationId } = parsed.data;

  const { ctx, canManage } = await resolveAutomationsScope(
    orgSlug,
    workspaceSlug,
  );
  if (!canManage) return { ok: false, error: MANAGE_DENIED };

  try {
    const result = await enableAutomation(ctx, automationId);
    revalidateAutomations(orgSlug, workspaceSlug);
    return { ok: true, result };
  } catch (err) {
    logger.error(
      { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId, automationId },
      "automations: enableAutomationAction failed",
    );
    return {
      ok: false,
      error:
        err instanceof Error ? err.message : "Failed to enable the automation.",
    };
  }
}

// ── Disable ──────────────────────────────────────────────────────────────────

export async function disableAutomationAction(
  input: z.input<typeof idSchema>,
): Promise<AutomationActionResult<{ result: AutomationDisableOutput }>> {
  const parsed = idSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }
  const { orgSlug, workspaceSlug, automationId } = parsed.data;

  const { ctx, canManage } = await resolveAutomationsScope(
    orgSlug,
    workspaceSlug,
  );
  if (!canManage) return { ok: false, error: MANAGE_DENIED };

  try {
    const result = await disableAutomation(ctx, automationId);
    revalidateAutomations(orgSlug, workspaceSlug);
    return { ok: true, result };
  } catch (err) {
    logger.error(
      { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId, automationId },
      "automations: disableAutomationAction failed",
    );
    return {
      ok: false,
      error:
        err instanceof Error
          ? err.message
          : "Failed to disable the automation.",
    };
  }
}

// ── Trigger now ──────────────────────────────────────────────────────────────

const triggerSchema = z.object({
  ...scopeShape,
  automationId: z.string().min(1),
  payload: z.record(z.unknown()).optional(),
});

export async function triggerAutomationAction(
  input: z.input<typeof triggerSchema>,
): Promise<AutomationActionResult<{ result: AutomationTriggerOutput }>> {
  const parsed = triggerSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }
  const { orgSlug, workspaceSlug, automationId, payload } = parsed.data;

  const { ctx, canManage } = await resolveAutomationsScope(
    orgSlug,
    workspaceSlug,
  );
  if (!canManage) return { ok: false, error: MANAGE_DENIED };

  try {
    const result = await triggerAutomation(ctx, automationId, payload);
    revalidateAutomations(orgSlug, workspaceSlug);
    return { ok: true, result };
  } catch (err) {
    logger.error(
      { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId, automationId },
      "automations: triggerAutomationAction failed",
    );
    return {
      ok: false,
      error:
        err instanceof Error
          ? err.message
          : "Failed to trigger the automation.",
    };
  }
}

// ── Update (name / description / trigger config) ──────────────────────────────

const updateSchema = z.object({
  ...scopeShape,
  automationId: z.string().min(1),
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).nullable().optional(),
  triggerConfig: triggerConfigSchema.optional(),
});

export async function updateAutomationAction(
  input: z.input<typeof updateSchema>,
): Promise<AutomationActionResult<{ result: AutomationUpdateOutput }>> {
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }
  const {
    orgSlug,
    workspaceSlug,
    automationId,
    name,
    description,
    triggerConfig,
  } = parsed.data;

  const { ctx, canManage } = await resolveAutomationsScope(
    orgSlug,
    workspaceSlug,
  );
  if (!canManage) return { ok: false, error: MANAGE_DENIED };

  try {
    const result = await updateAutomation(ctx, {
      automation_id: automationId,
      name,
      description,
      triggerConfig,
    });
    revalidateAutomations(orgSlug, workspaceSlug);
    revalidatePath(
      workspace.automations.automation(
        { orgSlug, workspaceSlug },
        automationId,
      ),
    );
    return { ok: true, result };
  } catch (err) {
    logger.error(
      { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId, automationId },
      "automations: updateAutomationAction failed",
    );
    return {
      ok: false,
      error:
        err instanceof Error ? err.message : "Failed to update the automation.",
    };
  }
}
