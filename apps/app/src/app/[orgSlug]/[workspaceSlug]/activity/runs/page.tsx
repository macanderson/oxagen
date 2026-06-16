/**
 * page.tsx — Workspace → Activity → Runs.
 *
 * The single home for all run kinds (IA spec §5). Fetches the two live kinds —
 * subagent fan-outs (`agent.subagent.fanout.list`) and parallel tasks (agent
 * executions, formerly the standalone /workflows page) — and hands both to the
 * filterable client view. Chat/API/MCP runs join once `activity.runs.list`
 * (ClickHouse) ships.
 */
import type { Metadata } from "next";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { invoke } from "@oxagen/oxagen";
import "@oxagen/handlers/register";
import "@oxagen/agent/register";
import { desc, eq } from "drizzle-orm";
import { resolveOrg, resolveWorkspace, assertOrgMember } from "@/lib/resolve-org";
import { getSessionOrRedirect } from "@/lib/session";
import { RunsView } from "./runs-view";
import type { RunTask } from "./task-table";
import type { AgentSubagentFanoutListOutput } from "./fanout-actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Runs — Activity",
};

interface PageProps {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}

function formatDuration(startedAt: Date | null, completedAt: Date | null): string {
  if (!startedAt) return "—";
  const end = completedAt ?? new Date();
  const s = Math.floor((end.getTime() - startedAt.getTime()) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function formatDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default async function ActivityRunsPage({ params }: PageProps) {
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

  const { fanouts, tasks } = await runInTenantScope(
    { orgId: org.id, workspaceId: ws.id },
    async () => {
      const fanoutOut = (await invoke(
        "agent.subagent.fanout.list",
        { limit: 50 },
        ctx,
        { surface: "agent" },
      )) as AgentSubagentFanoutListOutput;

      const taskRows = await withTenantDb((db) =>
        db
          .select()
          .from(schema.agentExecutions)
          .where(eq(schema.agentExecutions.workspaceId, ws.id))
          .orderBy(desc(schema.agentExecutions.createdAt))
          .limit(50),
      );

      const mappedTasks: RunTask[] = taskRows.map((row) => {
        const payload = (row.inputPayload ?? {}) as { title?: string; goal?: string };
        return {
          id: row.id,
          title: payload.title ?? "",
          goal: payload.goal ?? "",
          status: row.status as RunTask["status"],
          durationLabel: formatDuration(row.startedAt, row.completedAt),
          createdLabel: formatDate(row.createdAt),
        };
      });

      return { fanouts: fanoutOut.fanouts, tasks: mappedTasks };
    },
  );

  return (
    <RunsView
      fanouts={fanouts}
      tasks={tasks}
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
    />
  );
}
