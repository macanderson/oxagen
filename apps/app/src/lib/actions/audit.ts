"use server";

import "@oxagen/handlers/register";
import { invoke } from "@oxagen/oxagen";
import { auditLogQuery } from "@oxagen/oxagen/contracts/audit.log.query";
import type { AuditLogQueryOutput } from "@oxagen/oxagen/contracts/audit.log.query";
import { getSessionOrRedirect } from "@/lib/session";
import {
  resolveOrg,
  resolveWorkspace,
  assertOrgMember,
} from "@/lib/resolve-org";

export async function queryAuditLogAction(input: {
  orgSlug: string;
  workspaceSlug: string;
  source?: "all" | "security" | "playbook";
  capability?: string;
  outcome?: "allow" | "deny" | "error" | "success";
  limit?: number;
  offset?: number;
}): Promise<AuditLogQueryOutput> {
  const session = await getSessionOrRedirect();
  const org = await resolveOrg(input.orgSlug);
  const ws = await resolveWorkspace(org.id, input.workspaceSlug);
  await assertOrgMember(org.id, session.user.id);

  const ctx = {
    orgId: org.id,
    workspaceId: ws.id,
    userId: session.user.id,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
  };

  const parsedInput = auditLogQuery.input.parse({
    source: input.source ?? "all",
    workspaceId: ws.id,
    capability: input.capability,
    outcome: input.outcome,
    limit: input.limit ?? 50,
    offset: input.offset ?? 0,
  });

  const result = await invoke(auditLogQuery.name, parsedInput, ctx, {
    surface: "agent",
  });
  return auditLogQuery.output.parse(result);
}
