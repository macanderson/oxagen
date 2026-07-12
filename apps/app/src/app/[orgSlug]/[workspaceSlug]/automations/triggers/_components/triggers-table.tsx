"use client";
/**
 * triggers-table.tsx — the workspace-wide Triggers board: every agent.trigger.*
 * binding across every agent, in one table.
 *
 * Filters (search by agent name, trigger type, enabled state) are client-side
 * over the already-loaded rows, mirroring automations/_components/
 * automations-table.tsx. `canManage` (workspace Owner/Admin) hides the
 * mutating row actions for read-only members. `failedAgents` surfaces a
 * partial-failure banner without blanking the rows that DID load — per spec,
 * one agent's list_triggers failure never hides the rest of the board.
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  MoreHorizontal,
  Pencil,
  Power,
  PowerOff,
  Radio,
  Trash2,
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
import { Input } from "@/components/ui/input";
import { Menu, MenuTrigger, MenuPopup, MenuItem } from "@/components/ui/menu";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
} from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { EmptyState } from "@/app/[orgSlug]/[workspaceSlug]/_shared/components";
import { workspace } from "@/lib/routes";
import type { WorkspaceTriggerRow } from "@/lib/automations/triggers";
import { toggleTriggerAction, deleteTriggerAction } from "../actions";
import { TriggerFormDialog, type TriggerFormFilter } from "./trigger-form-dialog";
import { DeleteTriggerDialog } from "./delete-trigger-dialog";

const TYPE_LABEL: Record<WorkspaceTriggerRow["triggerType"], string> = {
  manual: "Manual",
  schedule: "Schedule",
  event: "Event",
};

function typeBadgeVariant(
  t: WorkspaceTriggerRow["triggerType"],
): "info-soft" | "warning-soft" | "muted" {
  if (t === "event") return "info-soft";
  if (t === "schedule") return "warning-soft";
  return "muted";
}

function rowKey(row: WorkspaceTriggerRow): string {
  return `${row.agentId}:${row.triggerId}`;
}

function toFormTrigger(row: WorkspaceTriggerRow, enabled: boolean) {
  return {
    type: row.triggerType,
    eventSource: row.eventSource ?? undefined,
    eventType: row.eventType ?? undefined,
    connectionId: row.connectionId ?? undefined,
    filter: row.filter as TriggerFormFilter | undefined,
    schedule: row.schedule ?? undefined,
    enabled,
  };
}

export interface TriggersTableProps {
  rows: WorkspaceTriggerRow[];
  failedAgents: number;
  canManage: boolean;
  orgSlug: string;
  workspaceSlug: string;
}

export function TriggersTable({
  rows,
  failedAgents,
  canManage,
  orgSlug,
  workspaceSlug,
}: TriggersTableProps) {
  const router = useRouter();
  const toast = useToast();
  const ctx = { orgSlug, workspaceSlug };

  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | WorkspaceTriggerRow["triggerType"]>("all");
  const [stateFilter, setStateFilter] = useState<"all" | "enabled" | "disabled">("all");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<WorkspaceTriggerRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceTriggerRow | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (q && !r.agentName.toLowerCase().includes(q)) return false;
      if (typeFilter !== "all" && r.triggerType !== typeFilter) return false;
      if (stateFilter === "enabled" && !r.enabled) return false;
      if (stateFilter === "disabled" && r.enabled) return false;
      return true;
    });
  }, [rows, search, typeFilter, stateFilter]);

  async function handleToggle(row: WorkspaceTriggerRow) {
    const key = rowKey(row);
    setBusyKey(key);
    const res = await toggleTriggerAction({
      orgSlug,
      workspaceSlug,
      triggerId: row.triggerId,
      trigger: toFormTrigger(row, !row.enabled),
    });
    setBusyKey(null);
    if (res.ok) {
      toast.add({
        title: row.enabled ? "Trigger disabled" : "Trigger enabled",
        description: `${row.agentName} · ${TYPE_LABEL[row.triggerType]}`,
        type: "success",
      });
      router.refresh();
    } else {
      toast.add({ title: "Couldn't update the trigger", description: res.error, type: "error" });
    }
  }

  async function handleConfirmDelete() {
    if (!deleteTarget) return;
    const row = deleteTarget;
    const res = await deleteTriggerAction({ orgSlug, workspaceSlug, triggerId: row.triggerId });
    if (res.ok) {
      toast.add({
        title: "Trigger deleted",
        description: `${row.agentName} · ${TYPE_LABEL[row.triggerType]}`,
        type: "success",
      });
      setDeleteTarget(null);
      router.refresh();
    } else {
      toast.add({ title: "Couldn't delete the trigger", description: res.error, type: "error" });
      setDeleteTarget(null);
    }
  }

  // True empty state: nothing loaded and nothing failed to load.
  if (rows.length === 0 && failedAgents === 0) {
    return (
      <EmptyState
        icon={Radio}
        title="No triggers configured across any agent yet."
        description="Create a manual, schedule, or event trigger from any agent to see it here."
      />
    );
  }

  const failureBanner = failedAgents > 0 && (
    <div
      className="flex items-center gap-2 rounded-md border border-warning/25 bg-warning/10 p-3 text-sm text-warning"
      role="alert"
      data-testid="triggers-partial-failure"
    >
      <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
      {failedAgents} agent{failedAgents === 1 ? "" : "s"} failed to load — showing the rest.
    </div>
  );

  // All agents failed and none returned triggers — nothing to filter/table.
  if (rows.length === 0) {
    return <div className="flex flex-col gap-3">{failureBanner}</div>;
  }

  return (
    <div className="flex flex-col gap-3">
      {failureBanner}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by agent…"
          className="h-9 w-full max-w-xs"
          aria-label="Search triggers by agent name"
          data-testid="triggers-search"
        />
        <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v as typeof typeFilter)}>
          <SelectTrigger size="sm" className="w-40" aria-label="Filter by trigger type">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="all">All trigger types</SelectItem>
            <SelectItem value="manual">Manual</SelectItem>
            <SelectItem value="schedule">Schedule</SelectItem>
            <SelectItem value="event">Event</SelectItem>
          </SelectPopup>
        </Select>
        <Select value={stateFilter} onValueChange={(v) => setStateFilter(v as typeof stateFilter)}>
          <SelectTrigger size="sm" className="w-36" aria-label="Filter by enabled state">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="all">All states</SelectItem>
            <SelectItem value="enabled">Enabled</SelectItem>
            <SelectItem value="disabled">Disabled</SelectItem>
          </SelectPopup>
        </Select>
      </div>

      <Table data-testid="triggers-table">
        <TableHeader>
          <TableRow>
            <TableHead>Agent</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Binding</TableHead>
            <TableHead>Enabled</TableHead>
            <TableHead>Next fire</TableHead>
            {canManage && <TableHead className="w-10 text-right">Actions</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {filtered.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={canManage ? 6 : 5}
                className="py-8 text-center text-sm text-muted-foreground"
              >
                No triggers match your filters.
              </TableCell>
            </TableRow>
          ) : (
            filtered.map((row) => {
              const key = rowKey(row);
              const agentHref = workspace.workbench.agent(ctx, row.agentPublicId);
              return (
                <TableRow key={key} data-testid={`trigger-row-${key}`}>
                  <TableCell>
                    <Link href={agentHref} className="font-medium text-foreground hover:underline">
                      {row.agentName}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant={typeBadgeVariant(row.triggerType)} size="sm">
                      {TYPE_LABEL[row.triggerType]}
                    </Badge>
                  </TableCell>
                  <TableCell
                    className="max-w-xs truncate text-sm text-muted-foreground"
                    title={row.bindingSummary}
                  >
                    {row.bindingSummary}
                  </TableCell>
                  <TableCell>
                    <Badge variant={row.enabled ? "success-soft" : "muted"} size="sm">
                      {row.enabled ? "Enabled" : "Disabled"}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {row.triggerType === "schedule" ? (row.schedule ?? "—") : "—"}
                  </TableCell>
                  {canManage && (
                    <TableCell className="text-right">
                      <Menu>
                        <MenuTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`Actions for ${row.agentName} trigger`}
                              data-testid={`row-actions-${key}`}
                            />
                          }
                        >
                          <MoreHorizontal className="size-4" />
                        </MenuTrigger>
                        <MenuPopup align="end">
                          <MenuItem onClick={() => setEditTarget(row)} data-testid={`edit-${key}`}>
                            <Pencil className="size-4" /> Edit
                          </MenuItem>
                          {row.enabled ? (
                            <MenuItem
                              disabled={busyKey === key}
                              onClick={() => void handleToggle(row)}
                              data-testid={`disable-${key}`}
                            >
                              <PowerOff className="size-4" /> Disable
                            </MenuItem>
                          ) : (
                            <MenuItem
                              disabled={busyKey === key}
                              onClick={() => void handleToggle(row)}
                              data-testid={`enable-${key}`}
                            >
                              <Power className="size-4" /> Enable
                            </MenuItem>
                          )}
                          <MenuItem
                            variant="destructive"
                            onClick={() => setDeleteTarget(row)}
                            data-testid={`delete-${key}`}
                          >
                            <Trash2 className="size-4" /> Delete
                          </MenuItem>
                        </MenuPopup>
                      </Menu>
                    </TableCell>
                  )}
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>

      {editTarget && (
        <TriggerFormDialog
          mode="edit"
          open={editTarget !== null}
          onOpenChange={(open) => !open && setEditTarget(null)}
          orgSlug={orgSlug}
          workspaceSlug={workspaceSlug}
          agentName={editTarget.agentName}
          triggerId={editTarget.triggerId}
          initial={{
            type: editTarget.triggerType,
            eventSource: editTarget.eventSource ?? undefined,
            eventType: editTarget.eventType ?? undefined,
            connectionId: editTarget.connectionId ?? undefined,
            filter: editTarget.filter as TriggerFormFilter | undefined,
            schedule: editTarget.schedule ?? undefined,
            enabled: editTarget.enabled,
          }}
          onSaved={() => {
            setEditTarget(null);
            router.refresh();
          }}
        />
      )}

      <DeleteTriggerDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        agentName={deleteTarget?.agentName ?? ""}
        triggerType={deleteTarget ? TYPE_LABEL[deleteTarget.triggerType] : ""}
        onConfirm={handleConfirmDelete}
      />
    </div>
  );
}
