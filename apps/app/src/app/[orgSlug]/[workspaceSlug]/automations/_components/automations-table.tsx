"use client";
/**
 * automations-table.tsx — the Automations tab table: every automation in the
 * workspace, its trigger type, and whether it's live, with human-gated row
 * actions (enable behind a confirm dialog; disable / trigger-now direct).
 *
 * Filters (search by name, trigger type, enabled state) are client-side over
 * the already-loaded rows. `canManage` (workspace Owner/Admin) hides the
 * mutating actions for read-only members.
 *
 * NOTE (contract gap): automation.list returns only { id, name, status,
 * triggerType }. "Last fired" and "Run count" are not in its output, so those
 * spec columns are surfaced per-automation on the editor's run-history tab
 * (audit spine) rather than here — flagged in the PR.
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  MoreHorizontal,
  Play,
  Pencil,
  Power,
  PowerOff,
  Zap,
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
import type { AutomationListOutput } from "@oxagen/oxagen/contracts/automation.list";
import { EnableConfirmDialog } from "./enable-confirm-dialog";
import { TriggerNowDialog } from "./trigger-now-dialog";
import { NewAutomationButton } from "./new-automation-button";
import {
  enableAutomationAction,
  disableAutomationAction,
  triggerAutomationAction,
} from "../actions";

type Row = AutomationListOutput[number];

const TRIGGER_LABEL: Record<string, string> = {
  event: "Graph event",
  schedule: "Schedule",
  api: "API / manual",
};

function triggerBadgeVariant(
  t: string,
): "info-soft" | "warning-soft" | "muted" {
  if (t === "event") return "info-soft";
  if (t === "schedule") return "warning-soft";
  return "muted";
}

function isEnabled(row: Row): boolean {
  return row.status === "active";
}

export interface AutomationsTableProps {
  automations: AutomationListOutput;
  canManage: boolean;
  orgSlug: string;
  workspaceSlug: string;
}

export function AutomationsTable({
  automations,
  canManage,
  orgSlug,
  workspaceSlug,
}: AutomationsTableProps) {
  const router = useRouter();
  const toast = useToast();

  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<
    "all" | "event" | "schedule" | "api"
  >("all");
  const [stateFilter, setStateFilter] = useState<
    "all" | "enabled" | "disabled"
  >("all");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [enableTarget, setEnableTarget] = useState<Row | null>(null);
  const [triggerTarget, setTriggerTarget] = useState<Row | null>(null);

  const ctx = { orgSlug, workspaceSlug };

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return automations.filter((a) => {
      if (q && !a.name.toLowerCase().includes(q)) return false;
      if (typeFilter !== "all" && a.triggerType !== typeFilter) return false;
      if (stateFilter === "enabled" && !isEnabled(a)) return false;
      if (stateFilter === "disabled" && isEnabled(a)) return false;
      return true;
    });
  }, [automations, search, typeFilter, stateFilter]);

  async function handleDisable(row: Row) {
    setBusyId(row.id);
    // finally: a rejected action would otherwise leave the row's menu item
    // disabled until the page is reloaded.
    try {
      const res = await disableAutomationAction({
        orgSlug,
        workspaceSlug,
        automationId: row.id,
      });
      if (res.ok) {
        toast.add({
          title: "Automation disabled",
          description: row.name,
          type: "success",
        });
        router.refresh();
      } else {
        toast.add({
          title: "Couldn't disable",
          description: res.error,
          type: "error",
        });
      }
    } finally {
      setBusyId(null);
    }
  }

  async function handleConfirmEnable() {
    if (!enableTarget) return;
    const row = enableTarget;
    const res = await enableAutomationAction({
      orgSlug,
      workspaceSlug,
      automationId: row.id,
    });
    if (res.ok) {
      toast.add({
        title: "Automation enabled",
        description: `${row.name} is now live.`,
        type: "success",
      });
      setEnableTarget(null);
      router.refresh();
    } else {
      toast.add({
        title: "Couldn't enable",
        description: res.error,
        type: "error",
      });
      setEnableTarget(null);
    }
  }

  if (automations.length === 0) {
    return (
      <EmptyState
        icon={Zap}
        title="No automations yet"
        description="Create an automation to run a playbook on a graph event, a schedule, or on demand. Nothing fires until you enable it."
        action={
          canManage ? (
            <NewAutomationButton
              orgSlug={orgSlug}
              workspaceSlug={workspaceSlug}
              testId="new-automation-empty"
            />
          ) : undefined
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search automations…"
          className="h-9 w-full max-w-xs"
          aria-label="Search automations by name"
          data-testid="automations-search"
        />
        <Select
          value={typeFilter}
          onValueChange={(v) => setTypeFilter(v as typeof typeFilter)}
        >
          <SelectTrigger
            size="sm"
            className="w-40"
            aria-label="Filter by trigger type"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="all">All trigger types</SelectItem>
            <SelectItem value="event">Graph event</SelectItem>
            <SelectItem value="schedule">Schedule</SelectItem>
            <SelectItem value="api">API / manual</SelectItem>
          </SelectPopup>
        </Select>
        <Select
          value={stateFilter}
          onValueChange={(v) => setStateFilter(v as typeof stateFilter)}
        >
          <SelectTrigger
            size="sm"
            className="w-36"
            aria-label="Filter by enabled state"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="all">All states</SelectItem>
            <SelectItem value="enabled">Enabled</SelectItem>
            <SelectItem value="disabled">Disabled</SelectItem>
          </SelectPopup>
        </Select>
      </div>

      <Table data-testid="automations-table">
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Trigger</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="w-10 text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={4}
                className="py-8 text-center text-sm text-muted-foreground"
              >
                No automations match your filters.
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row) => {
              const enabled = isEnabled(row);
              const detailHref = workspace.automations.automation(ctx, row.id);
              return (
                <TableRow key={row.id}>
                  <TableCell>
                    <Link
                      href={detailHref}
                      className="font-medium text-foreground hover:underline"
                    >
                      {row.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={triggerBadgeVariant(row.triggerType)}
                      size="sm"
                    >
                      {TRIGGER_LABEL[row.triggerType] ?? row.triggerType}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={enabled ? "success-soft" : "muted"}
                      size="sm"
                    >
                      {enabled ? "Enabled" : "Disabled"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Menu>
                      <MenuTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Actions for ${row.name}`}
                            data-testid={`row-actions-${row.id}`}
                          />
                        }
                      >
                        <MoreHorizontal className="size-4" />
                      </MenuTrigger>
                      <MenuPopup align="end">
                        <MenuItem render={<Link href={detailHref} />}>
                          <Pencil className="size-4" /> Edit
                        </MenuItem>
                        {canManage && (
                          <MenuItem
                            onClick={() => setTriggerTarget(row)}
                            data-testid={`trigger-${row.id}`}
                          >
                            <Play className="size-4" /> Trigger now
                          </MenuItem>
                        )}
                        {canManage &&
                          (enabled ? (
                            <MenuItem
                              variant="destructive"
                              disabled={busyId === row.id}
                              onClick={() => void handleDisable(row)}
                              data-testid={`disable-${row.id}`}
                            >
                              <PowerOff className="size-4" /> Disable
                            </MenuItem>
                          ) : (
                            <MenuItem
                              onClick={() => setEnableTarget(row)}
                              data-testid={`enable-${row.id}`}
                            >
                              <Power className="size-4" /> Enable
                            </MenuItem>
                          ))}
                      </MenuPopup>
                    </Menu>
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>

      <EnableConfirmDialog
        open={enableTarget !== null}
        onOpenChange={(open) => !open && setEnableTarget(null)}
        automationName={enableTarget?.name ?? ""}
        onConfirm={handleConfirmEnable}
      />

      <TriggerNowDialog
        open={triggerTarget !== null}
        onOpenChange={(open) => !open && setTriggerTarget(null)}
        automationName={triggerTarget?.name ?? ""}
        onTrigger={async (payload) => {
          if (!triggerTarget)
            return { ok: false, error: "No automation selected." };
          const res = await triggerAutomationAction({
            orgSlug,
            workspaceSlug,
            automationId: triggerTarget.id,
            payload,
          });
          if (res.ok) {
            router.refresh();
            return {
              ok: true,
              executionId: res.result.execution_id,
              status: res.result.status,
            };
          }
          return { ok: false, error: res.error };
        }}
      />
    </div>
  );
}
