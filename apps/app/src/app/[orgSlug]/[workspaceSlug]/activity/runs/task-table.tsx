/**
 * task-table.tsx — presentational table of parallel-task runs.
 *
 * "Parallel tasks" are the agent-execution runs that used to live on the
 * standalone /workflows page (now folded into Activity → Runs per IA spec §5;
 * "Workflow" is a banned term per §19). Pure presentation: the server page
 * pre-formats every cell into a `RunTask`, so this stays trivially testable.
 */
import { CheckCircle2, XCircle, Loader2, Clock, Ban } from "lucide-react";
import { cn } from "@/lib/utils";
import type { WorkflowRunSnapshot } from "@oxagen/oxagen/contracts/workflow.status";

type TaskStatus = WorkflowRunSnapshot["status"];

export interface RunTask {
  id: string;
  title: string;
  goal: string;
  status: TaskStatus;
  durationLabel: string;
  createdLabel: string;
}

const STATUS_CONFIG: Record<
  TaskStatus,
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

function TaskRow({ task }: { task: RunTask }) {
  const cfg = STATUS_CONFIG[task.status] ?? STATUS_CONFIG.failed;
  const Icon = cfg.icon;
  return (
    <tr className="group border-b border-border/50 hover:bg-muted/30 transition-colors">
      <td className="py-3 pl-4 pr-3">
        <div className="flex flex-col gap-0.5 min-w-0">
          <span className="text-sm font-medium text-foreground truncate max-w-xs">
            {task.title || "—"}
          </span>
          <span className="text-xs text-muted-foreground truncate max-w-xs">{task.goal}</span>
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
      <td className="py-3 px-3 text-xs tabular-nums text-muted-foreground whitespace-nowrap">
        {task.durationLabel}
      </td>
      <td className="py-3 pl-3 pr-4 text-xs text-muted-foreground whitespace-nowrap">
        {task.createdLabel}
      </td>
    </tr>
  );
}

export function TaskTable({ tasks }: { tasks: RunTask[] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border/60" data-testid="task-table">
      <table className="w-full text-sm" aria-label="Parallel task runs">
        <thead>
          <tr className="border-b border-border/60 bg-muted/30">
            <th className="py-2.5 pl-4 pr-3 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Task
            </th>
            <th className="py-2.5 px-3 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Status
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
          {tasks.map((task) => (
            <TaskRow key={task.id} task={task} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
