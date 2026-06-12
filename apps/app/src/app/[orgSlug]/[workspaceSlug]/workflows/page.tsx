import { CheckCircle2, XCircle, Loader2, Clock, CircleDot, Ban } from "lucide-react";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { desc, eq } from "drizzle-orm";
import { resolveOrg, resolveWorkspace } from "@/lib/resolve-org";
import { cn } from "@/lib/utils";
import type { WorkflowRunSnapshot } from "@oxagen/oxagen/contracts/workflow.status";

export const dynamic = "force-dynamic";

type WorkflowStatus = WorkflowRunSnapshot["status"];

const STATUS_CONFIG: Record<
  WorkflowStatus,
  { icon: React.ElementType; iconClass: string; badgeClass: string; label: string }
> = {
  planning: {
    icon: Clock,
    iconClass: "text-blue-500",
    badgeClass: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
    label: "Planning",
  },
  running: {
    icon: Loader2,
    iconClass: "text-primary animate-spin",
    badgeClass: "bg-primary/10 text-primary",
    label: "Running",
  },
  completed: {
    icon: CheckCircle2,
    iconClass: "text-emerald-500",
    badgeClass: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
    label: "Completed",
  },
  failed: {
    icon: XCircle,
    iconClass: "text-destructive",
    badgeClass: "bg-destructive/10 text-destructive",
    label: "Failed",
  },
  cancelled: {
    icon: Ban,
    iconClass: "text-muted-foreground",
    badgeClass: "bg-muted text-muted-foreground",
    label: "Cancelled",
  },
};

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

type WorkflowRow = typeof schema.agentExecutions.$inferSelect;

function WorkflowTableRow({ run }: { run: WorkflowRow }) {
  const payload = (run.inputPayload ?? {}) as {
    title?: string;
    goal?: string;
  };
  const cfg = STATUS_CONFIG[run.status as WorkflowStatus] ?? STATUS_CONFIG.failed;
  const Icon = cfg.icon;

  return (
    <tr className="group border-b border-border/50 hover:bg-muted/30 transition-colors">
      <td className="py-3 pl-4 pr-3">
        <div className="flex flex-col gap-0.5 min-w-0">
          <span className="text-sm font-medium text-foreground truncate max-w-xs">
            {payload.title ?? "—"}
          </span>
          <span className="text-xs text-muted-foreground truncate max-w-xs">
            {payload.goal ?? ""}
          </span>
        </div>
      </td>
      <td className="py-3 px-3">
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold",
            cfg.badgeClass,
          )}
        >
          <Icon className={cn("h-3 w-3", cfg.iconClass)} aria-hidden="true" />
          {cfg.label}
        </span>
      </td>
      <td className="py-3 px-3 min-w-[100px]">
        <span className="text-xs text-muted-foreground">—</span>
      </td>
      <td className="py-3 px-3 text-xs tabular-nums text-muted-foreground whitespace-nowrap">
        {formatDuration(run.startedAt, run.completedAt)}
      </td>
      <td className="py-3 pl-3 pr-4 text-xs text-muted-foreground whitespace-nowrap">
        {formatDate(run.createdAt)}
      </td>
    </tr>
  );
}

export default async function WorkflowsPage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;

  const tenant = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(tenant.id, workspaceSlug);

  const runs = await runInTenantScope({ orgId: tenant.id, workspaceId: ws.id }, () =>
    withTenantDb((db) =>
      db
        .select()
        .from(schema.agentExecutions)
        .where(eq(schema.agentExecutions.workspaceId, ws.id))
        .orderBy(desc(schema.agentExecutions.createdAt))
        .limit(50),
    ),
  );

  const running = runs.filter((r) => r.status === "running" || r.status === "planning").length;
  const completed = runs.filter((r) => r.status === "completed").length;
  const failed = runs.filter((r) => r.status === "failed").length;

  return (
    <div className="flex flex-col gap-5 max-w-4xl px-6 py-6">
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: "Active", value: running },
          { label: "Completed", value: completed },
          { label: "Failed", value: failed },
        ].map(({ label, value }) => (
          <div
            key={label}
            className="flex flex-col gap-0.5 rounded-lg border border-border/60 bg-card px-4 py-3"
          >
            <span className="text-xs text-muted-foreground">{label}</span>
            <span className="text-xl font-semibold tabular-nums text-foreground">{value}</span>
          </div>
        ))}
      </div>

      {runs.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-border/50 bg-card px-6 py-12 text-center">
          <CircleDot className="h-8 w-8 text-muted-foreground/40" aria-hidden="true" />
          <div>
            <p className="text-sm font-medium text-foreground">No workflows yet</p>
            <p className="mt-1 text-xs text-muted-foreground max-w-xs mx-auto">
              Ask the agent to research something at scale — for example,{" "}
              <em>&ldquo;profile all Fortune 500 CEOs&rdquo;</em> — and it will spin up a
              parallel workflow here.
            </p>
          </div>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border/60">
          <table className="w-full text-sm" aria-label="Workflow runs">
            <thead>
              <tr className="border-b border-border/60 bg-muted/30">
                <th className="py-2.5 pl-4 pr-3 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Workflow
                </th>
                <th className="py-2.5 px-3 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Status
                </th>
                <th className="py-2.5 px-3 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Progress
                </th>
                <th className="py-2.5 px-3 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Duration
                </th>
                <th className="py-2.5 pl-3 pr-4 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Created
                </th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <WorkflowTableRow key={run.id} run={run} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Workflows run up to 500 concurrent tasks. Results are retained for 90 days. Start a
        workflow by asking the agent to research at scale.
      </p>
    </div>
  );
}
