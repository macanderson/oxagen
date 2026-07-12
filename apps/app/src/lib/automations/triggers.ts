/**
 * lib/automations/triggers.ts — typed server calls into the agent.trigger.* /
 * agent.definition.list capability families, plus the workspace-wide fan-out
 * that assembles the Triggers board.
 *
 * CONTRACT GAP (flagged, not fixed — packages/oxagen/src/contracts/** is out
 * of this module's ownership): agent.trigger.list (`list_triggers`) is scoped
 * to a single `agentId` per call — there is no workspace-wide trigger list
 * endpoint. `listWorkspaceTriggers` below enumerates every agent via
 * agent.definition.list (`list_agent_defs`) and fans `list_triggers` out per
 * agent with Promise.allSettled, tolerating individual per-agent failures (a
 * rejected agent is dropped and counted in `failedAgents`; the rest still
 * render — "don't blank the whole table" per the spec). A true
 * workspace-scoped list_triggers would remove this fan-out; note as a future
 * contract improvement, not a blocker.
 *
 * Second gap: agentTriggerSchema (packages/oxagen/src/agent-schema.ts) has no
 * timezone field for schedule triggers (unlike automation.triggerConfig,
 * which does carry one) — cron expressions are UTC-implicit until the schema
 * gains a field. Also out of this module's ownership.
 *
 * Mirrors lib/automations/automations.ts: thin ctx-based wrappers that parse
 * input/output against each contract and dispatch through invoke() with NO
 * opts.surface override — the kernel's surface allowlist gate only fires when
 * opts.surface is explicitly set (kernel.ts:578), so omitting it lets the
 * trusted app surface reach agent.trigger.* / agent.definition.list (which
 * list "agent" but not "app" in surfaces[]) while ctx.surface="app" keeps
 * attribution honest.
 *
 * Server-only: imports the handler registry. Never import from a "use client"
 * module.
 */
import "@oxagen/handlers/register";
import { invoke } from "@oxagen/oxagen";
import { agentTriggerList } from "@oxagen/oxagen/contracts/agent.trigger.list";
import { agentTriggerCreate } from "@oxagen/oxagen/contracts/agent.trigger.create";
import { agentTriggerUpdate } from "@oxagen/oxagen/contracts/agent.trigger.update";
import { agentTriggerDelete } from "@oxagen/oxagen/contracts/agent.trigger.delete";
import { agentDefinitionList } from "@oxagen/oxagen/contracts/agent.definition.list";
import type { AgentTriggerListOutput } from "@oxagen/oxagen/contracts/agent.trigger.list";
import type { AgentTriggerCreateOutput } from "@oxagen/oxagen/contracts/agent.trigger.create";
import type { AgentTriggerUpdateOutput } from "@oxagen/oxagen/contracts/agent.trigger.update";
import type { AgentTriggerDeleteOutput } from "@oxagen/oxagen/contracts/agent.trigger.delete";
import type { AgentDefinitionListOutput } from "@oxagen/oxagen/contracts/agent.definition.list";
import type { AgentTrigger, AgentTriggerType } from "@oxagen/oxagen/agent-schema";
import { resolveAutomationsScope } from "./scope";
import type { AutomationsCtx } from "./scope";

/** The full trigger binding config accepted by create/update — the
 *  agentTriggerSchema shape (type + type-specific fields + enabled). */
export type TriggerConfig = AgentTrigger;

// ── Agent enumeration ────────────────────────────────────────────────────────

/**
 * List every agent definition in the current workspace, unfiltered by status
 * — the Triggers board audits everything, including archived agents whose
 * triggers may still be configured (and could still misfire).
 */
export async function listAgentDefs(
  ctx: AutomationsCtx,
): Promise<AgentDefinitionListOutput> {
  const input = agentDefinitionList.input.parse({});
  const out = await invoke(agentDefinitionList.name, input, ctx);
  return agentDefinitionList.output.parse(out);
}

export interface AgentOption {
  agentId: string;
  publicId: string;
  name: string;
  agentType: string;
}

/**
 * Agents eligible to have a NEW trigger attached — excludes product-managed
 * (built-in) agents, which agent.definition.list documents as read-only:
 * "viewable but not editable, publishable, deployable, or trigger-configurable".
 */
export async function listAgentOptions(
  ctx: AutomationsCtx,
): Promise<AgentOption[]> {
  const { agents } = await listAgentDefs(ctx);
  return agents
    .filter((a) => !a.managed)
    .map((a) => ({
      agentId: a.agentId,
      publicId: a.publicId,
      name: a.name,
      agentType: a.agentType,
    }));
}

// ── Per-agent trigger CRUD ───────────────────────────────────────────────────

export async function listTriggers(
  ctx: AutomationsCtx,
  agentId: string,
): Promise<AgentTriggerListOutput> {
  const input = agentTriggerList.input.parse({ agentId });
  const out = await invoke(agentTriggerList.name, input, ctx);
  return agentTriggerList.output.parse(out);
}

export async function createTrigger(
  ctx: AutomationsCtx,
  agentId: string,
  trigger: TriggerConfig,
): Promise<AgentTriggerCreateOutput> {
  const input = agentTriggerCreate.input.parse({ agentId, trigger });
  const out = await invoke(agentTriggerCreate.name, input, ctx);
  return agentTriggerCreate.output.parse(out);
}

export async function updateTrigger(
  ctx: AutomationsCtx,
  triggerId: string,
  trigger: TriggerConfig,
): Promise<AgentTriggerUpdateOutput> {
  const input = agentTriggerUpdate.input.parse({ triggerId, trigger });
  const out = await invoke(agentTriggerUpdate.name, input, ctx);
  return agentTriggerUpdate.output.parse(out);
}

export async function deleteTrigger(
  ctx: AutomationsCtx,
  triggerId: string,
): Promise<AgentTriggerDeleteOutput> {
  const input = agentTriggerDelete.input.parse({ triggerId });
  const out = await invoke(agentTriggerDelete.name, input, ctx);
  return agentTriggerDelete.output.parse(out);
}

// ── Binding summary ──────────────────────────────────────────────────────────

interface FilterShape {
  branches?: unknown;
  pathGlobs?: unknown;
  conditions?: unknown;
}

function filterIsNonEmpty(filter: Record<string, unknown> | null | undefined): boolean {
  const f = (filter ?? {}) as FilterShape;
  const hasBranches = Array.isArray(f.branches) && f.branches.length > 0;
  const hasPathGlobs = Array.isArray(f.pathGlobs) && f.pathGlobs.length > 0;
  const hasConditions =
    f.conditions !== null &&
    typeof f.conditions === "object" &&
    Object.keys(f.conditions as Record<string, unknown>).length > 0;
  return hasBranches || hasPathGlobs || hasConditions;
}

/** Human-readable summary of what fires a trigger, for the table column. */
export function describeBinding(trigger: {
  triggerType: AgentTriggerType;
  schedule: string | null;
  eventSource: string | null;
  eventType: string | null;
  filter: Record<string, unknown>;
}): string {
  if (trigger.triggerType === "manual") return "Manual — run on demand";
  if (trigger.triggerType === "schedule") {
    return trigger.schedule ? `cron ${trigger.schedule}` : "No cron set";
  }
  const source = trigger.eventSource ?? "unknown source";
  const type = trigger.eventType ?? "unknown event";
  return `${source} / ${type}${filterIsNonEmpty(trigger.filter) ? " (filtered)" : ""}`;
}

// ── Workspace-wide fan-out (the Triggers board data loader) ────────────────

export interface WorkspaceTriggerRow {
  agentId: string;
  agentPublicId: string;
  agentName: string;
  triggerId: string;
  triggerType: AgentTriggerType;
  bindingSummary: string;
  enabled: boolean;
  schedule: string | null;
  eventSource: string | null;
  eventType: string | null;
  connectionId: string | null;
  filter: Record<string, unknown>;
}

export interface ListWorkspaceTriggersResult {
  rows: WorkspaceTriggerRow[];
  /** Count of agents whose list_triggers call rejected — the rest still render. */
  failedAgents: number;
  canManage: boolean;
}

/**
 * Assemble the workspace-wide Triggers board:
 *   1. resolveAutomationsScope → ctx, canManage.
 *   2. list_agent_defs to enumerate every agent in the workspace.
 *   3. Fan agent.trigger.list out per agent via Promise.allSettled — a
 *      rejected per-agent call is dropped and counted in `failedAgents`; the
 *      rest still assemble into `rows`.
 *
 * Never catches a failure of step 1 or 2 — those propagate so the caller (the
 * async RSC section) can render a whole-fan-out error banner instead of a
 * silently empty board.
 */
export async function listWorkspaceTriggers(
  orgSlug: string,
  workspaceSlug: string,
): Promise<ListWorkspaceTriggersResult> {
  const { ctx, canManage } = await resolveAutomationsScope(orgSlug, workspaceSlug);
  const { agents } = await listAgentDefs(ctx);

  const settled = await Promise.allSettled(
    agents.map(async (agent) => ({
      agent,
      triggers: (await listTriggers(ctx, agent.agentId)).triggers,
    })),
  );

  let failedAgents = 0;
  const rows: WorkspaceTriggerRow[] = [];
  for (const result of settled) {
    if (result.status === "rejected") {
      failedAgents += 1;
      continue;
    }
    const { agent, triggers } = result.value;
    for (const trigger of triggers) {
      rows.push({
        agentId: agent.agentId,
        agentPublicId: agent.publicId,
        agentName: agent.name,
        triggerId: trigger.publicId,
        triggerType: trigger.triggerType,
        bindingSummary: describeBinding(trigger),
        enabled: trigger.enabled,
        schedule: trigger.schedule,
        eventSource: trigger.eventSource,
        eventType: trigger.eventType,
        connectionId: trigger.connectionId,
        filter: trigger.filter,
      });
    }
  }

  return { rows, failedAgents, canManage };
}
