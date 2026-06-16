/**
 * page.tsx — Workspace → Agents → Subagent Runs → one fan-out (detail).
 *
 * Server component: auth → resolve org/workspace → invoke
 * agent.subagent.fanout.get, then hand the snapshot to the live detail client.
 * A missing/forbidden fan-out (handler throws "not found") renders notFound().
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { runInTenantScope } from "@oxagen/tenancy";
import { invoke } from "@oxagen/oxagen";
import "@oxagen/handlers/register";
import "@oxagen/agent/register";
import { resolveOrg, resolveWorkspace, assertOrgMember } from "@/lib/resolve-org";
import { getSessionOrRedirect } from "@/lib/session";
import { FanoutDetail } from "../fanout-detail";
import type { AgentSubagentFanoutGetOutput } from "../fanout-actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Subagent Run — Workspace",
};

interface PageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string; fanoutId: string }>;
}

export default async function SubagentRunDetailPage({ params }: PageProps) {
  const { orgSlug, workspaceSlug, fanoutId } = await params;
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

  let fanout: AgentSubagentFanoutGetOutput;
  try {
    fanout = await runInTenantScope(
      { orgId: org.id, workspaceId: ws.id },
      () =>
        invoke(
          "agent.subagent.fanout.get",
          { fanoutId },
          ctx,
          { surface: "agent" },
        ) as Promise<AgentSubagentFanoutGetOutput>,
    );
  } catch {
    notFound();
  }

  return (
    <FanoutDetail
      initialFanout={fanout}
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
    />
  );
}
