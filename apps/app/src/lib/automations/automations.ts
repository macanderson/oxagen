/**
 * lib/automations/automations.ts — typed server calls into the automation.*
 * capability family via invoke().
 *
 * Thin wrappers that parse input/output against the contract and dispatch
 * through the kernel. Each takes an already-resolved AutomationsCtx (from
 * resolveAutomationsScope) so the caller — a Server Action or an async RSC —
 * owns the session/scope/IAM gate.
 *
 * invoke() is called with NO `opts.surface` override: the kernel's surface
 * allowlist gate only fires when opts.surface is explicitly set (kernel.ts:578),
 * so omitting it lets ctx.surface="app" flow through for correct attribution
 * while the automation.* contracts (which list "agent" but not "app" in
 * surfaces[]) are still reachable — the first-party app is a trusted surface.
 * This matches the shipped app enable path in app/actions/automation-inline.action.ts.
 *
 * Server-only: imports the handler registry. Never import from a "use client"
 * module.
 */
import "@oxagen/handlers/register";
import type { z } from "zod";
import { invoke } from "@oxagen/oxagen";
import { automationList } from "@oxagen/oxagen/contracts/automation.list";
import { automationGet } from "@oxagen/oxagen/contracts/automation.get";
import { automationCreate } from "@oxagen/oxagen/contracts/automation.create";
import { automationEnable } from "@oxagen/oxagen/contracts/automation.enable";
import { automationDisable } from "@oxagen/oxagen/contracts/automation.disable";
import { automationTrigger } from "@oxagen/oxagen/contracts/automation.trigger";
import { automationUpdate } from "@oxagen/oxagen/contracts/automation.update";
import type { AutomationListOutput } from "@oxagen/oxagen/contracts/automation.list";
import type { AutomationGetOutput } from "@oxagen/oxagen/contracts/automation.get";
import type { AutomationCreateOutput } from "@oxagen/oxagen/contracts/automation.create";
import type { AutomationEnableOutput } from "@oxagen/oxagen/contracts/automation.enable";
import type { AutomationDisableOutput } from "@oxagen/oxagen/contracts/automation.disable";
import type { AutomationTriggerOutput } from "@oxagen/oxagen/contracts/automation.trigger";
import type { AutomationUpdateOutput } from "@oxagen/oxagen/contracts/automation.update";
import type { AutomationsCtx } from "./scope";

/**
 * Argument types accept the contract's z.input (pre-defaults) rather than
 * z.output: callers pass partial trigger config / steps and the contract's
 * .parse() fills the defaults before dispatch.
 */
export type CreateAutomationArgs = z.input<typeof automationCreate.input>;
export type UpdateAutomationArgs = z.input<typeof automationUpdate.input>;

/** List every automation in the workspace (populates the Automations table). */
export async function listAutomations(
  ctx: AutomationsCtx,
): Promise<AutomationListOutput> {
  const input = automationList.input.parse({ workspace_id: ctx.workspaceId });
  const out = await invoke(automationList.name, input, ctx);
  return automationList.output.parse(out);
}

/**
 * Read one automation's full detail — trigger config, playbook steps, and the
 * 20 most-recent runs — for the editor page. (automation.list returns only
 * name/status/triggerType; this is the single-automation read.)
 */
export async function getAutomation(
  ctx: AutomationsCtx,
  automationId: string,
): Promise<AutomationGetOutput> {
  const input = automationGet.input.parse({ automation_id: automationId });
  const out = await invoke(automationGet.name, input, ctx);
  return automationGet.output.parse(out);
}

/** Create a new automation. Human-origin app calls honor `enabled` per the contract. */
export async function createAutomation(
  ctx: AutomationsCtx,
  input: CreateAutomationArgs,
): Promise<AutomationCreateOutput> {
  const parsed = automationCreate.input.parse(input);
  const out = await invoke(automationCreate.name, parsed, ctx);
  return automationCreate.output.parse(out);
}

/**
 * Enable an automation trigger so it fires live. THE human gate: only reachable
 * from a direct human action behind the confirm dialog — never an agent surface.
 */
export async function enableAutomation(
  ctx: AutomationsCtx,
  automationId: string,
): Promise<AutomationEnableOutput> {
  const input = automationEnable.input.parse({ automation_id: automationId });
  const out = await invoke(automationEnable.name, input, ctx);
  return automationEnable.output.parse(out);
}

/** Disable an automation trigger (always safe — turning OFF has no side effect). */
export async function disableAutomation(
  ctx: AutomationsCtx,
  automationId: string,
): Promise<AutomationDisableOutput> {
  const input = automationDisable.input.parse({ automation_id: automationId });
  const out = await invoke(automationDisable.name, input, ctx);
  return automationDisable.output.parse(out);
}

/** Fire an automation on demand with an optional JSON payload (Trigger now). */
export async function triggerAutomation(
  ctx: AutomationsCtx,
  automationId: string,
  payload?: Record<string, unknown>,
): Promise<AutomationTriggerOutput> {
  const input = automationTrigger.input.parse({
    automation_id: automationId,
    payload,
  });
  const out = await invoke(automationTrigger.name, input, ctx);
  return automationTrigger.output.parse(out);
}

/** Edit name / description / trigger configuration (partial update). */
export async function updateAutomation(
  ctx: AutomationsCtx,
  input: UpdateAutomationArgs,
): Promise<AutomationUpdateOutput> {
  const parsed = automationUpdate.input.parse(input);
  const out = await invoke(automationUpdate.name, parsed, ctx);
  return automationUpdate.output.parse(out);
}
