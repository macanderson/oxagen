"use client";
import * as React from "react";
import { ChevronDown, ChevronUp, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatDuration } from "./tool-call-card";
import type { BackgroundTaskStatus } from "./background-task-types";

// Re-exported so existing importers (`./background-task-tray`) keep working; the
// canonical definition lives in the .ts types module so pure type consumers
// don't pull this .tsx component into their typecheck closure.
export type { BackgroundTaskStatus };

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
  const value = React.useMemo(
    () => ({ taskIds, push, remove }),
    [taskIds, push, remove],
  );
  return (
    <TaskTrayContext.Provider value={value}>
      {children}
    </TaskTrayContext.Provider>
  );
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

// Bounded backoff for polling active background tasks.
//
// When the tray is visible and at least one task is non-terminal, we poll
// with an exponential backoff: starting at BASE_POLL_MS, doubling each tick
// up to MAX_POLL_MS. This bounds the long-tail polling cost without losing
// responsiveness on short-lived tasks.
//
// When the tray is collapsed (hidden) or all tasks are terminal the poll
// loop stops entirely — no network work while the tray is out of view.
const BASE_POLL_MS = 2_000;
const MAX_POLL_MS = 30_000;

export function BackgroundTaskTray({
  initialTaskIds,
  fetchTask,
  cancelTask,
}: BackgroundTaskTrayProps) {
  // The tray reads from the shared context if one exists so any component
  // can `useTaskTray().push(taskId)` to register a new task without
  // prop-drilling. Falls back to internal state otherwise.
  const ctx = React.useContext(TaskTrayContext);
  const [localIds, setLocalIds] = React.useState<string[]>(
    initialTaskIds ?? [],
  );
  const taskIds = ctx?.taskIds ?? localIds;
  const removeFromLocal = React.useCallback((id: string) => {
    setLocalIds((prev) => prev.filter((x) => x !== id));
  }, []);
  const remove = ctx?.remove ?? removeFromLocal;

  const [snapshots, setSnapshots] = React.useState<
    Record<string, BackgroundTaskSnapshot>
  >({});
  const [collapsed, setCollapsed] = React.useState(false);

  // Stable ref so the interval callback can read current snapshots without
  // the timeout resetting on every snapshot update.
  const snapshotsRef = React.useRef(snapshots);
  React.useEffect(() => {
    snapshotsRef.current = snapshots;
  }, [snapshots]);

  // Poll active tasks with bounded exponential backoff. Stops when:
  //   1. The tray is collapsed (collapsed === true),
  //   2. All tracked tasks have reached a terminal state, or
  //   3. KNOWN GAP — every `fetchTask` in a tick rejected. `stillActive` below
  //      is derived only from FULFILLED results, so a tick in which they all
  //      reject schedules no successor and the loop stops for good (the effect
  //      deps don't change, so nothing restarts it). A single network blip
  //      therefore freezes the tray at its last snapshot until the task list
  //      or the collapsed state changes. Fixing it means distinguishing
  //      "nothing active" from "nothing known" and retrying on the backoff.
  // Resets the backoff to BASE_POLL_MS whenever new taskIds arrive.
  React.useEffect(() => {
    if (collapsed || taskIds.length === 0) return;

    let cancelled = false;
    let intervalMs = BASE_POLL_MS;
    let timerId: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      // Check whether any task is still non-terminal before hitting the network.
      const hasActive = taskIds.some((id) => {
        const snap = snapshotsRef.current[id];
        return !snap || !TERMINAL.includes(snap.status);
      });
      if (!hasActive) return; // All terminal — stop without scheduling next tick.

      const results = await Promise.allSettled(
        taskIds.map((id) => fetchTask(id)),
      );
      if (cancelled) return;

      setSnapshots((prev) => {
        const next = { ...prev };
        results.forEach((r, i) => {
          if (r.status === "fulfilled") next[taskIds[i]!] = r.value;
        });
        return next;
      });

      // Check again after the fetch — if everything is now terminal, don't
      // schedule the next tick.
      const stillActive = results.some(
        (r) => r.status === "fulfilled" && !TERMINAL.includes(r.value.status),
      );
      if (!stillActive || cancelled) return;

      // Schedule next tick with bounded backoff.
      intervalMs = Math.min(intervalMs * 2, MAX_POLL_MS);
      timerId = setTimeout(() => {
        void tick();
      }, intervalMs);
    };

    // Kick off immediately, then the recursive setTimeout chain takes over.
    timerId = setTimeout(() => {
      void tick();
    }, 0);

    return () => {
      cancelled = true;
      if (timerId !== null) clearTimeout(timerId);
    };
  }, [taskIds, fetchTask, collapsed]);

  if (taskIds.length === 0) return null;

  const activeCount = taskIds.filter((id) => {
    const snap = snapshots[id];
    return !snap || !TERMINAL.includes(snap.status);
  }).length;

  return (
    <div className="fixed bottom-[calc(var(--bottom-bar-h)+var(--bottom-bar-gap)+env(safe-area-inset-bottom))] right-4 z-50 w-80 max-w-[calc(100vw-2rem)] md:bottom-[calc(1rem+env(safe-area-inset-bottom))]">
      <div className="rounded-xl border bg-card text-card-foreground shadow overflow-hidden p-0">
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
        >
          <Loader2
            className={cn(
              "h-3.5 w-3.5",
              activeCount > 0
                ? "animate-spin text-foreground"
                : "text-muted-foreground",
            )}
          />
          <span className="font-semibold">Background tasks</span>
          <span className="ml-auto text-xs font-medium tabular-nums text-muted-foreground">
            {activeCount}/{taskIds.length}
          </span>
          {collapsed ? (
            <ChevronUp className="h-4 w-4" />
          ) : (
            <ChevronDown className="h-4 w-4" />
          )}
        </button>
        {!collapsed ? (
          <div className="max-h-96 space-y-2 overflow-y-auto border-t px-3 py-3">
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
  const elapsed = useElapsed(
    snapshot?.startedAt ?? snapshot?.createdAt ?? null,
    snapshot?.completedAt ?? null,
  );
  const isTerminal = TERMINAL.includes(status);
  const [cancelling, setCancelling] = React.useState(false);

  const handleCancel = async () => {
    if (!onCancel) return;
    setCancelling(true);
    try {
      await onCancel(taskId);
    } finally {
      // A thrown cancel action would otherwise leave `cancelling` true, which
      // disables the Cancel button for the rest of the task's life.
      setCancelling(false);
    }
  };

  return (
    <div className="rounded-xl bg-muted p-2 text-xs">
      <div className="flex items-center gap-2">
        <span className="font-semibold">
          {snapshot?.label ?? snapshot?.kind ?? taskId}
        </span>
        <span
          className={cn(
            "ml-auto inline-flex items-center gap-1 text-xs font-medium",
            status === "completed"
              ? "text-success"
              : status === "failed" || status === "cancelled"
                ? "text-destructive"
                : "text-muted-foreground",
          )}
        >
          {status}
        </span>
      </div>
      <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground tabular-nums">
        <span>{snapshot?.kind ?? "—"}</span>
        <span>{formatDuration(elapsed)}</span>
      </div>
      {typeof snapshot?.progress === "number" ? (
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full bg-primary transition-all"
            style={{
              width: `${Math.min(100, Math.max(0, snapshot.progress * 100))}%`,
            }}
          />
        </div>
      ) : null}
      {snapshot?.failureReason ? (
        <p className="mt-1 text-[10px] text-destructive">
          {snapshot.failureReason}
        </p>
      ) : null}
      <div className="mt-1 flex items-center justify-end gap-1">
        {!isTerminal && onCancel ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleCancel}
            disabled={cancelling}
          >
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

function useElapsed(
  startedAt: string | null,
  completedAt: string | null,
): number {
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
