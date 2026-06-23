/**
 * runs-section.tsx — Async server component that fetches fanouts and agent
 * executions concurrently via Promise.all and renders RunsView. Wrapped in
 * <Suspense> by the parent page so the route shell paints immediately while
 * this component streams in.
 */
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { invoke } from "@oxagen/oxagen";
import "@oxagen/handlers/register";
import "@oxagen/agent/register";
import { and, desc, eq } from "drizzle-orm";
import { RunsView } from "./runs-view";
import type { RunTask } from "./task-table";
import type { AgentSubagentFanoutListOutput } from "./fanout-actions";

// ---------------------------------------------------------------------------
// Helpers (moved from page.tsx so they live alongside the fetch logic)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface RunsSectionProps {
  orgId: string;
  workspaceId: string;
  userId: string;
  orgSlug: string;
  workspaceSlug: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export async function RunsSection({
  orgId,
  workspaceId,
  userId,
  orgSlug,
  workspaceSlug,
}: RunsSectionProps) {
  const ctx = {
    orgId,
    workspaceId,
    userId,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
  };

  const { fanouts, tasks } = await runInTenantScope(
    { orgId, workspaceId },
    async () => {
      const [fanoutOut, taskRows] = await Promise.all([
        invoke(
          "agent.subagent.fanout.list",
          { limit: 50 },
          ctx,
          { surface: "agent" },
        ) as Promise<AgentSubagentFanoutListOutput>,
        withTenantDb((db) =>
          db
            .select()
            .from(schema.agentExecutions)
            // The Runs view lists workflow runs (workflow.run → agent_executions
            // with origin_type='workflow_run'). Chat-origin executions are
            // conversations, not runs — excluding them stops them being
            // mislabeled as parallel tasks here.
            .where(
              and(
                eq(schema.agentExecutions.workspaceId, workspaceId),
                eq(schema.agentExecutions.originType, "workflow_run"),
              ),
            )
            .orderBy(desc(schema.agentExecutions.createdAt))
            .limit(50),
        ),
      ]);

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
