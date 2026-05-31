"use client";
import * as React from "react";
import { ChevronDown, ChevronUp, Loader2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatDuration } from "./tool-call-card";

export type BackgroundTaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface BackgroundTaskSnapshot {
  taskId: string;
  kind: string;
  label: string | null;
  status: BackgroundTaskStatus;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  progress?: number | null;
  failureReason?: string | null;
}

type Fetcher = (taskId: string) => Promise<BackgroundTaskSnapshot>;
type Cancel = (taskId: string) => Promise<{ ok: boolean; error?: string }>;

interface TrayContextValue {
  push: (taskId: string) => void;
  remove: (taskId: string) => void;
  taskIds: string[];
}

const TaskTrayContext = React.createContext<TrayContextValue | null>(null);

export function TaskTrayProvider({
  initialTaskIds = [],
  children,
}: {
  initialTaskIds?: string[];
  children: React.ReactNode;
}) {
  const [taskIds, setTaskIds] = React.useState<string[]>(initialTaskIds);
  const push = React.useCallback((taskId: string) => {
    setTaskIds((prev) => (prev.includes(taskId) ? prev : [...prev, taskId]));
  }, []);
  const remove = React.useCallback((taskId: string) => {
    setTaskIds((prev) => prev.filter((id) => id !== taskId));
  }, []);
  const value = React.useMemo(() => ({ taskIds, push, remove }), [taskIds, push, remove]);
  return <TaskTrayContext.Provider value={value}>{children}</TaskTrayContext.Provider>;
}

export function useTaskTray(): TrayContextValue {
  const ctx = React.useContext(TaskTrayContext);
  if (!ctx) {
    throw new Error("useTaskTray must be used inside <TaskTrayProvider>");
  }
  return ctx;
}

export interface BackgroundTaskTrayProps {
  initialTaskIds?: string[];
  fetchTask: Fetcher;
  cancelTask?: Cancel;
}

const TERMINAL: BackgroundTaskStatus[] = ["completed", "failed", "cancelled"];

export function BackgroundTaskTray({ initialTaskIds, fetchTask, cancelTask }: BackgroundTaskTrayProps) {
  // The tray reads from the shared context if one exists so any component
  // can `useTaskTray().push(taskId)` to register a new task without
  // prop-drilling. Falls back to internal state otherwise.
  const ctx = React.useContext(TaskTrayContext);
  const [localIds, setLocalIds] = React.useState<string[]>(initialTaskIds ?? []);
  const taskIds = ctx?.taskIds ?? localIds;
  const removeFromLocal = React.useCallback((id: string) => {
    setLocalIds((prev) => prev.filter((x) => x !== id));
  }, []);
  const remove = ctx?.remove ?? removeFromLocal;

  const [snapshots, setSnapshots] = React.useState<Record<string, BackgroundTaskSnapshot>>({});
  const [collapsed, setCollapsed] = React.useState(false);

  // Poll every 2s while any tracked task is non-terminal. When all tracked
  // tasks are terminal the interval clears itself so the tray stops doing
  // network work.
  React.useEffect(() => {
    if (taskIds.length === 0) return;
    let cancelled = false;
    const tick = async () => {
      const results = await Promise.allSettled(taskIds.map((id) => fetchTask(id)));
      if (cancelled) return;
      setSnapshots((prev) => {
        const next = { ...prev };
        results.forEach((r, i) => {
          if (r.status === "fulfilled") next[taskIds[i]!] = r.value;
        });
        return next;
      });
    };
    tick();
    const hasActive = () =>
      taskIds.some((id) => {
        const snap = snapshots[id];
        return !snap || !TERMINAL.includes(snap.status);
      });
    if (!hasActive()) return;
    const interval = setInterval(tick, 2000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // `snapshots` is intentionally excluded: the tick updater always reads
    // fresh state via `setSnapshots(prev => ...)`, so a stale closure is
    // safe. Including `snapshots` would reset the interval on every poll,
    // causing thrash. The `hasActive()` check on line above reads the
    // in-scope `snapshots` from the render that set up this effect — a
    // one-tick lag is acceptable because the interval self-clears on the
    // next run once all tasks are terminal.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- snapshots intentionally excluded; see comment above
  }, [taskIds, fetchTask]);

  if (taskIds.length === 0) return null;

  const activeCount = taskIds.filter((id) => {
    const snap = snapshots[id];
    return !snap || !TERMINAL.includes(snap.status);
  }).length;

  return (
    <div className="fixed bottom-[calc(3.5rem+env(safe-area-inset-bottom)+0.5rem)] right-4 z-50 w-80 max-w-[calc(100vw-2rem)] md:bottom-[calc(1rem+env(safe-area-inset-bottom))]">
      <div className="glass-panel overflow-hidden p-0">
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
        >
          <Loader2
            className={cn("h-3.5 w-3.5", activeCount > 0 ? "animate-spin text-accent" : "text-muted-foreground")}
          />
          <span className="font-semibold">Background tasks</span>
          <Badge variant="muted" className="ml-auto">
            {activeCount}/{taskIds.length}
          </Badge>
          {collapsed ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
        {!collapsed ? (
          <div className="max-h-96 space-y-2 overflow-y-auto border-t border-[color:var(--glass-border)] px-3 py-3">
            {taskIds.map((id) => (
              <TaskRow
                key={id}
                taskId={id}
                snapshot={snapshots[id]}
                onCancel={cancelTask}
                onDismiss={remove}
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function TaskRow({
  taskId,
  snapshot,
  onCancel,
  onDismiss,
}: {
  taskId: string;
  snapshot?: BackgroundTaskSnapshot;
  onCancel?: Cancel;
  onDismiss: (id: string) => void;
}) {
  const status = snapshot?.status ?? "pending";
  const elapsed = useElapsed(snapshot?.startedAt ?? snapshot?.createdAt ?? null, snapshot?.completedAt ?? null);
  const isTerminal = TERMINAL.includes(status);
  const [cancelling, setCancelling] = React.useState(false);

  const handleCancel = async () => {
    if (!onCancel) return;
    setCancelling(true);
    await onCancel(taskId);
    setCancelling(false);
  };

  return (
    <div className="rounded-xl bg-background/40 p-2 text-xs">
      <div className="flex items-center gap-2">
        <span className="font-semibold">{snapshot?.label ?? snapshot?.kind ?? taskId}</span>
        <Badge
          variant={
            status === "completed"
              ? "success"
              : status === "failed" || status === "cancelled"
              ? "destructive"
              : "muted"
          }
          className="ml-auto"
        >
          {status}
        </Badge>
      </div>
      <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground tabular-nums">
        <span>{snapshot?.kind ?? "—"}</span>
        <span>{formatDuration(elapsed)}</span>
      </div>
      {typeof snapshot?.progress === "number" ? (
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full bg-accent transition-all"
            style={{ width: `${Math.min(100, Math.max(0, snapshot.progress * 100))}%` }}
          />
        </div>
      ) : null}
      {snapshot?.failureReason ? (
        <p className="mt-1 text-[10px] text-destructive">{snapshot.failureReason}</p>
      ) : null}
      <div className="mt-1 flex items-center justify-end gap-1">
        {!isTerminal && onCancel ? (
          <Button variant="ghost" size="sm" onClick={handleCancel} disabled={cancelling}>
            Cancel
          </Button>
        ) : null}
        {isTerminal ? (
          <Button variant="ghost" size="sm" onClick={() => onDismiss(taskId)}>
            <X className="h-3 w-3" />
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function useElapsed(startedAt: string | null, completedAt: string | null): number {
  const start = startedAt ? new Date(startedAt).getTime() : null;
  const end = completedAt ? new Date(completedAt).getTime() : null;
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (end !== null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [end]);
  if (start === null) return 0;
  return (end ?? now) - start;
}
