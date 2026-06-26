"use server";

import "@oxagen/handlers/register";
import { invoke } from "@oxagen/oxagen";
import { agentTriggerList } from "@oxagen/oxagen/contracts/agent.trigger.list";
import { agentTriggerCreate } from "@oxagen/oxagen/contracts/agent.trigger.create";
import { agentTriggerUpdate } from "@oxagen/oxagen/contracts/agent.trigger.update";
import { agentTriggerDelete } from "@oxagen/oxagen/contracts/agent.trigger.delete";
import type { AgentTriggerListOutput } from "@oxagen/oxagen/contracts/agent.trigger.list";
import type { AgentTriggerCreateOutput } from "@oxagen/oxagen/contracts/agent.trigger.create";
import type { AgentTriggerUpdateOutput } from "@oxagen/oxagen/contracts/agent.trigger.update";
import type { AgentTriggerDeleteOutput } from "@oxagen/oxagen/contracts/agent.trigger.delete";
import { getSessionOrRedirect } from "@/lib/session";
import { resolveOrg, resolveWorkspace, assertOrgMember } from "@/lib/resolve-org";
import { revalidatePath } from "next/cache";

async function buildTriggerCtx(orgSlug: string, workspaceSlug: string) {
  const session = await getSessionOrRedirect();
  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);
  await assertOrgMember(org.id, session.user.id);
  return {
    orgId: org.id,
    workspaceId: ws.id,
    userId: session.user.id,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
    _path: `/${orgSlug}/${workspaceSlug}/automation/triggers`,
  };
}

export async function listTriggersAction(input: {
  orgSlug: string;
  workspaceSlug: string;
  agentId: string;
}): Promise<AgentTriggerListOutput> {
  const { _path, ...ctx } = await buildTriggerCtx(input.orgSlug, input.workspaceSlug);
  const parsedInput = agentTriggerList.input.parse({ agentId: input.agentId });
  const result = await invoke(agentTriggerList.name, parsedInput, ctx, { surface: "agent" });
  return agentTriggerList.output.parse(result);
}

export async function createTriggerAction(input: {
  orgSlug: string;
  workspaceSlug: string;
  agentId: string;
  trigger: {
    type: "manual" | "schedule" | "event";
    eventSource?: string;
    eventType?: string;
    connectionId?: string;
    schedule?: string;
    enabled?: boolean;
  };
}): Promise<AgentTriggerCreateOutput> {
  const { _path, ...ctx } = await buildTriggerCtx(input.orgSlug, input.workspaceSlug);
  const parsedInput = agentTriggerCreate.input.parse({
    agentId: input.agentId,
    trigger: input.trigger,
  });
  const result = await invoke(agentTriggerCreate.name, parsedInput, ctx, { surface: "agent" });
  revalidatePath(_path);
  return agentTriggerCreate.output.parse(result);
}

export async function updateTriggerAction(input: {
  orgSlug: string;
  workspaceSlug: string;
  triggerId: string;
  trigger: {
    type: "manual" | "schedule" | "event";
    eventSource?: string;
    eventType?: string;
    connectionId?: string;
    schedule?: string;
    enabled?: boolean;
  };
}): Promise<AgentTriggerUpdateOutput> {
  const { _path, ...ctx } = await buildTriggerCtx(input.orgSlug, input.workspaceSlug);
  const parsedInput = agentTriggerUpdate.input.parse({
    triggerId: input.triggerId,
    trigger: input.trigger,
  });
  const result = await invoke(agentTriggerUpdate.name, parsedInput, ctx, { surface: "agent" });
  revalidatePath(_path);
  return agentTriggerUpdate.output.parse(result);
}

export async function deleteTriggerAction(input: {
  orgSlug: string;
  workspaceSlug: string;
  triggerId: string;
}): Promise<AgentTriggerDeleteOutput> {
  const { _path, ...ctx } = await buildTriggerCtx(input.orgSlug, input.workspaceSlug);
  const parsedInput = agentTriggerDelete.input.parse({ triggerId: input.triggerId });
  const result = await invoke(agentTriggerDelete.name, parsedInput, ctx, { surface: "agent" });
  revalidatePath(_path);
  return agentTriggerDelete.output.parse(result);
}
