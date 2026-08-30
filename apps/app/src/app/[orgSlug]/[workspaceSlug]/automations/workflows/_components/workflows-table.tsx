"use client";
/**
 * workflows-table.tsx — the Workflows & swarms table: server-loaded workflow
 * runs (Workflows tab) plus client-session-tracked research swarms (Swarms
 * tab, see swarm-session-store.ts contract-gap note), each row opening a
 * detail drawer that reuses the chat render components for live progress.
 *
 * `canManage` (workspace Owner/Admin) gates the Cancel row action — apps/app
 * does not bootstrap IAM, so this table-level gate plus the Server Action's
 * own canManage check (see ../actions.ts) are the authorization boundary for
 * mutations initiated from this page.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  MoreHorizontal,
  Eye,
  Ban,
  Workflow as WorkflowIcon,
} from "lucide-react";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Menu, MenuTrigger, MenuPopup, MenuItem } from "@/components/ui/menu";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/ui/segmented-control";
import { useToast } from "@/components/ui/toast";
import { EmptyState } from "@/app/[orgSlug]/[workspaceSlug]/_shared/components";
import {
  formatCost,
  formatDuration,
  statusBadgeVariant,
  timeAgo,
} from "@/components/activity/format";
import type { WorkflowRunRow } from "@/lib/automations/workflows";
import { cancelWorkflowAction } from "../actions";
import {
  WorkflowDetailDrawer,
  type WorkflowDetailTarget,
} from "./workflow-detail-drawer";
import {
  useSwarmSessionStore,
  type SwarmSessionRecord,
} from "./swarm-session-store";

const NON_TERMINAL_WORKFLOW_STATUSES = new Set(["planning", "running"]);
const SWARM_POLL_INTERVAL_MS = 5_000;
const SWARM_MAX_POLLS = 40; // ~3.3 min while the Swarms tab is active.

async function fetchSwarmStatus(
  orgSlug: string,
  workspaceSlug: string,
  swarmId: string,
): Promise<Pick<
  SwarmSessionRecord,
  "status" | "completedTasks" | "totalTasks"
> | null> {
  try {
    const res = await fetch(
      `/api/v1/${encodeURIComponent(orgSlug)}/${encodeURIComponent(workspaceSlug)}/research/swarm/status?swarmId=${encodeURIComponent(swarmId)}`,
      { headers: { "Content-Type": "application/json" } },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as {
      status?: string;
      completedTasks?: number;
      totalTasks?: number;
    };
    if (
      json.status !== "running" &&
      json.status !== "complete" &&
      json.status !== "failed"
    ) {
      return null;
    }
    return {
      status: json.status,
      completedTasks: json.completedTasks ?? 0,
      totalTasks: json.totalTasks ?? 0,
    };
  } catch {
    return null;
  }
}

function workflowLabel(row: WorkflowRunRow): string {
  if (row.title) return row.title;
  if (row.goal) return row.goal;
  return `Workflow ${row.executionId.slice(0, 8)}`;
}

function progressLabel(row: WorkflowRunRow): string {
  if (!row.enriched || row.totalTasks === undefined || row.totalTasks === 0)
    return "—";
  const completed = row.completedTasks ?? 0;
  return `${Math.round((completed / row.totalTasks) * 100)}%`;
}

export interface WorkflowsTableProps {
  workflows: WorkflowRunRow[];
  canManage: boolean;
  orgSlug: string;
  workspaceSlug: string;
}

export function WorkflowsTable({
  workflows,
  canManage,
  orgSlug,
  workspaceSlug,
}: WorkflowsTableProps) {
  const toast = useToast();
  const [view, setView] = useState<"workflows" | "swarms">("workflows");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [detail, setDetail] = useState<WorkflowDetailTarget | null>(null);

  const {
    swarms,
    updateSwarm,
    refresh: refreshSwarms,
  } = useSwarmSessionStore(orgSlug, workspaceSlug);

  // Resync from sessionStorage whenever the Swarms tab becomes active — the
  // header's LaunchWorkflowButton owns a separate hook instance (see
  // swarm-session-store.ts), so a just-launched swarm only appears here once
  // this instance re-reads storage.
  useEffect(() => {
    if (view === "swarms") refreshSwarms();
  }, [view, refreshSwarms]);

  // Poll REST swarm status directly (same route ResearchSwarmCard uses) for
  // any non-terminal swarm while the Swarms tab is visible, so the table's
  // status/progress columns don't go stale while the user browses the list.
  const swarmsRef = useRef(swarms);
  useEffect(() => {
    swarmsRef.current = swarms;
  }, [swarms]);

  useEffect(() => {
    if (view !== "swarms") return;
    let cancelled = false;
    let polls = 0;
    const id = setInterval(() => {
      if (cancelled) return;
      polls += 1;
      if (polls > SWARM_MAX_POLLS) {
        clearInterval(id);
        return;
      }
      const running = swarmsRef.current.filter((s) => s.status === "running");
      for (const s of running) {
        void fetchSwarmStatus(orgSlug, workspaceSlug, s.swarmId).then(
          (result) => {
            if (result && !cancelled) updateSwarm(s.swarmId, result);
          },
        );
      }
    }, SWARM_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [view, orgSlug, workspaceSlug, updateSwarm]);

  const handleCancel = useCallback(
    async (row: WorkflowRunRow) => {
      setBusyId(row.executionId);
      // finally: a rejected action would otherwise leave this row's Cancel
      // permanently disabled until the page is reloaded.
      try {
        const res = await cancelWorkflowAction({
          orgSlug,
          workspaceSlug,
          workflowId: row.executionId,
        });
        if (res.ok) {
          toast.add({ title: "Workflow cancelled", type: "success" });
        } else {
          toast.add({
            title: "Couldn't cancel",
            description: res.error,
            type: "error",
          });
        }
      } catch {
        toast.add({ title: "Couldn't cancel", type: "error" });
      } finally {
        setBusyId(null);
      }
    },
    [orgSlug, workspaceSlug, toast],
  );

  if (workflows.length === 0 && swarms.length === 0) {
    return (
      <EmptyState
        icon={WorkflowIcon}
        title="No workflows or swarms yet"
        description="Launch a workflow to fan a goal out into parallel sub-tasks, or a research swarm to fan out diverse web searches on a topic."
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <SegmentedControl
        value={view}
        onValueChange={(v) => setView(v as typeof view)}
      >
        <SegmentedControlItem value="workflows" data-testid="view-workflows">
          Workflows ({workflows.length})
        </SegmentedControlItem>
        <SegmentedControlItem value="swarms" data-testid="view-swarms">
          Swarms ({swarms.length})
        </SegmentedControlItem>
      </SegmentedControl>

      {view === "workflows" ? (
        workflows.length === 0 ? (
          <EmptyState
            icon={WorkflowIcon}
            title="No workflows yet"
            description="Launch a workflow to decompose a goal into parallel sub-tasks."
          />
        ) : (
          <Table data-testid="workflows-table">
            <TableHeader>
              <TableRow>
                <TableHead>Goal / Title</TableHead>
                <TableHead>Sub-tasks</TableHead>
                <TableHead>Progress</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Cost</TableHead>
                <TableHead className="w-10 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {workflows.map((row) => {
                const cancellable =
                  canManage && NON_TERMINAL_WORKFLOW_STATUSES.has(row.status);
                return (
                  <TableRow key={row.executionId}>
                    <TableCell>
                      <button
                        type="button"
                        className="max-w-xs truncate text-left font-medium text-foreground hover:underline"
                        title={workflowLabel(row)}
                        onClick={() =>
                          setDetail({
                            type: "workflow",
                            id: row.executionId,
                            title: row.title,
                            goal: row.goal,
                            status: row.status,
                          })
                        }
                        data-testid={`workflow-row-${row.executionId}`}
                      >
                        {workflowLabel(row)}
                      </button>
                    </TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">
                      {row.enriched ? (row.totalTasks ?? "—") : "—"}
                    </TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">
                      {progressLabel(row)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusBadgeVariant(row.status)} size="sm">
                        {row.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {timeAgo(row.startedAt ?? row.createdAt)}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {formatDuration(row.latencyMs)}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {formatCost(row.estimatedCostUsd) ?? "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <Menu>
                        <MenuTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`Actions for ${workflowLabel(row)}`}
                              data-testid={`row-actions-${row.executionId}`}
                            />
                          }
                        >
                          <MoreHorizontal className="size-4" />
                        </MenuTrigger>
                        <MenuPopup align="end">
                          <MenuItem
                            onClick={() =>
                              setDetail({
                                type: "workflow",
                                id: row.executionId,
                                title: row.title,
                                goal: row.goal,
                                status: row.status,
                              })
                            }
                          >
                            <Eye className="size-4" /> View
                          </MenuItem>
                          {cancellable && (
                            <MenuItem
                              variant="destructive"
                              disabled={busyId === row.executionId}
                              onClick={() => void handleCancel(row)}
                              data-testid={`cancel-${row.executionId}`}
                            >
                              <Ban className="size-4" /> Cancel
                            </MenuItem>
                          )}
                        </MenuPopup>
                      </Menu>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )
      ) : swarms.length === 0 ? (
        <EmptyState
          icon={WorkflowIcon}
          title="No swarms this session"
          description="Research swarms are tracked for the current browser session only (no persistent list yet) — launch one to see it here."
        />
      ) : (
        <Table data-testid="swarms-table">
          <TableHeader>
            <TableRow>
              <TableHead>Topic</TableHead>
              <TableHead>Depth</TableHead>
              <TableHead>Max parallel</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Progress</TableHead>
              <TableHead>Started</TableHead>
              <TableHead className="w-10 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {swarms.map((swarm) => (
              <TableRow key={swarm.swarmId}>
                <TableCell>
                  <button
                    type="button"
                    className="max-w-xs truncate text-left font-medium text-foreground hover:underline"
                    title={swarm.topic}
                    onClick={() => setDetail({ type: "swarm", swarm })}
                    data-testid={`swarm-row-${swarm.swarmId}`}
                  >
                    {swarm.topic}
                  </button>
                </TableCell>
                <TableCell className="capitalize text-muted-foreground">
                  {swarm.depth}
                </TableCell>
                <TableCell className="tabular-nums text-muted-foreground">
                  {swarm.maxParallel}
                </TableCell>
                <TableCell>
                  <Badge
                    variant={
                      swarm.status === "complete"
                        ? "success"
                        : swarm.status === "failed"
                          ? "error"
                          : "info"
                    }
                    size="sm"
                  >
                    {swarm.status}
                  </Badge>
                </TableCell>
                <TableCell className="tabular-nums text-muted-foreground">
                  {swarm.totalTasks > 0
                    ? `${swarm.completedTasks} / ${swarm.totalTasks}`
                    : "—"}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {timeAgo(swarm.launchedAt)}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`View ${swarm.topic}`}
                    onClick={() => setDetail({ type: "swarm", swarm })}
                    data-testid={`view-swarm-${swarm.swarmId}`}
                  >
                    <Eye className="size-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <WorkflowDetailDrawer
        target={detail}
        onOpenChange={(open) => !open && setDetail(null)}
        orgSlug={orgSlug}
        workspaceSlug={workspaceSlug}
        canManage={canManage}
      />
    </div>
  );
}
