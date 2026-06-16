/**
 * page.tsx — Workspace → Agents → Subagent Runs (fan-out list).
 *
 * Server component: auth → resolve org/workspace → invoke
 * agent.subagent.fanout.list, then hand the snapshot to the live client list.
 */
import type { Metadata } from "next";
import { runInTenantScope } from "@oxagen/tenancy";
import { invoke } from "@oxagen/oxagen";
import "@oxagen/handlers/register";
import "@oxagen/agent/register";
import { resolveOrg, resolveWorkspace, assertOrgMember } from "@/lib/resolve-org";
import { getSessionOrRedirect } from "@/lib/session";
import { FanoutList } from "./fanout-list";
import type { AgentSubagentFanoutListOutput } from "./fanout-actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Subagent Runs — Workspace",
};

interface PageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}

export default async function SubagentRunsPage({ params }: PageProps) {
  const { orgSlug, workspaceSlug } = await params;
  const session = await getSessionOrRedirect();

  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);
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

  const { fanouts } = await runInTenantScope(
    { orgId: org.id, workspaceId: ws.id },
    () =>
      invoke(
        "agent.subagent.fanout.list",
        { limit: 50 },
        ctx,
        { surface: "agent" },
      ) as Promise<AgentSubagentFanoutListOutput>,
  );

  return (
    <FanoutList
      initialFanouts={fanouts}
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
    />
  );
}
