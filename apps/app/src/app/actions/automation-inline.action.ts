"use server";

// ── Server actions: automation-inline ─────────────────────────────────────────
//
// Called from the automation-create-inline registry component.
// Both actions route through the single invoke() chokepoint for IAM, billing,
// and audit on every call. apps/app skips IAM bootstrap, so an explicit org
// member assertion is required at this call site.

import { invoke } from "@oxagen/oxagen";
// Bind every foundation handler into the shared kernel so invoke() resolves at
// runtime without needing the caller to know which package owns the handler.
import "@oxagen/handlers/register";
import type { ConditionNode } from "@oxagen/oxagen/trigger-conditions";
import type {
  AutomationCreateInput,
  AutomationCreateOutput,
} from "@oxagen/oxagen/contracts/automation.create";
import type { AutomationEnableOutput } from "@oxagen/oxagen/contracts/automation.enable";
import { getSessionOrRedirect } from "@/lib/session";
import {
  resolveOrg,
  resolveWorkspace,
  assertOrgMember,
} from "@/lib/resolve-org";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface AutomationCreateInlineInput {
  orgSlug: string;
  workspaceSlug: string;
  name: string;
  description?: string;
  triggerType: "event" | "schedule" | "api";
  triggerConfig?: {
    entityType?: string;
    eventType?: "node.created" | "node.updated" | "node.deleted";
    propertyConditions?: Array<{
      property: string;
      operator: "eq" | "gt" | "lt" | "changed";
      toValue?: unknown;
    }>;
    conditionTree?: ConditionNode;
    cronExpression?: string;
    timezone?: string;
  };
  steps?: Array<{
    name: string;
    stepType:
      | "agent"
      | "tool"
      | "condition"
      | "webhook"
      | "prompt"
      | "human_input";
    config?: Record<string, unknown>;
  }>;
}

export type AutomationCreateInlineResult =
  | { ok: true; automation: AutomationCreateOutput }
  | { ok: false; error: string };

export interface AutomationEnableInlineInput {
  orgSlug: string;
  workspaceSlug: string;
  automation_id: string;
}

export type AutomationEnableInlineResult =
  | { ok: true; result: AutomationEnableOutput }
  | { ok: false; error: string };

// ── createAutomationInlineAction ─────────────────────────────────────────────

export async function createAutomationInlineAction(
  input: AutomationCreateInlineInput,
): Promise<AutomationCreateInlineResult> {
  let session: Awaited<ReturnType<typeof getSessionOrRedirect>>;
  try {
    session = await getSessionOrRedirect();
  } catch {
    return { ok: false, error: "Not authenticated." };
  }

  let orgId: string;
  let workspaceId: string;
  try {
    const org = await resolveOrg(input.orgSlug);
    const ws = await resolveWorkspace(org.id, input.workspaceSlug);
    await assertOrgMember(org.id, session.user.id);
    orgId = org.id;
    workspaceId = ws.id;
  } catch {
    return { ok: false, error: "Org or workspace not found." };
  }

  const ctx = {
    orgId,
    workspaceId,
    userId: session.user.id,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
  };

  const contractInput: AutomationCreateInput = {
    name: input.name,
    description: input.description,
    triggerType: input.triggerType,
    triggerConfig: input.triggerConfig ?? {},
    steps: (input.steps ?? []).map((s) => ({
      name: s.name,
      stepType: s.stepType,
      config: s.config ?? {},
    })),
    // Always false: human must explicitly enable via the form button.
    enabled: false,
  };

  try {
    const result = (await invoke(
      "create_automation",
      contractInput,
      ctx,
    )) as AutomationCreateOutput;
    return { ok: true, automation: result };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Automation could not be created.";
    return { ok: false, error: message };
  }
}

// ── enableAutomationInlineAction ─────────────────────────────────────────────

export async function enableAutomationInlineAction(
  input: AutomationEnableInlineInput,
): Promise<AutomationEnableInlineResult> {
  let session: Awaited<ReturnType<typeof getSessionOrRedirect>>;
  try {
    session = await getSessionOrRedirect();
  } catch {
    return { ok: false, error: "Not authenticated." };
  }

  let orgId: string;
  let workspaceId: string;
  try {
    const org = await resolveOrg(input.orgSlug);
    const ws = await resolveWorkspace(org.id, input.workspaceSlug);
    await assertOrgMember(org.id, session.user.id);
    orgId = org.id;
    workspaceId = ws.id;
  } catch {
    return { ok: false, error: "Org or workspace not found." };
  }

  const ctx = {
    orgId,
    workspaceId,
    userId: session.user.id,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
  };

  try {
    const result = (await invoke(
      "enable_automation",
      { automation_id: input.automation_id },
      ctx,
    )) as AutomationEnableOutput;
    return { ok: true, result };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Automation could not be enabled.";
    return { ok: false, error: message };
  }
}
