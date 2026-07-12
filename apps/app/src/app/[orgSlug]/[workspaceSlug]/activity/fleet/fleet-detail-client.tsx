"use client";
/**
 * fleet-detail-client.tsx — one fan-out's detail view: header + rolled-up
 * stats, a timeline strip, and the per-child row table. Row click opens
 * <ChildDrawer> with that child's full input/output payload (fetched lazily
 * client-side via GET /api/v1/agent/subagent/result).
 */
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Download } from "lucide-react";
import type { AgentSubagentFanoutGetOutput } from "@oxagen/oxagen/contracts/agent.subagent_fanout.get";
import type { AgentSubagentAggregateOutput } from "@oxagen/oxagen/contracts/agent.subagent.aggregate";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CopyableId } from "@/components/knowledge/graph-explorer/copyable-id";
import { formatBytes } from "@/lib/utils";
import { formatDuration, formatTimestamp } from "@/components/activity/format";
import { workspace } from "@/lib/routes";
import { cancelFanoutAction } from "./actions";
import { CancelFanoutDialog } from "./cancel-fanout-dialog";
import { ChildDrawer } from "./child-drawer";
import {
  fanoutStatusVariant,
  isFanoutCancellable,
  runStatusVariant,
} from "./status";
import { layoutTimeline, timelineEntriesFrom } from "./timeline";

type FanoutRun = AgentSubagentFanoutGetOutput["runs"][number];

export interface FleetDetailClientProps {
  fanout: AgentSubagentFanoutGetOutput;
  aggregate: AgentSubagentAggregateOutput | null;
  orgSlug: string;
  workspaceSlug: string;
  workspaceId: string;
  canManage: boolean;
}

export function FleetDetailClient({
  fanout,
  aggregate,
  orgSlug,
  workspaceSlug,
  workspaceId,
  canManage,
}: FleetDetailClientProps) {
  const router = useRouter();
  const { add: toast } = useToast();
  const [cancelling, setCancelling] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [selectedRun, setSelectedRun] = useState<FanoutRun | null>(null);

  const listPath = workspace.activity.fleet({ orgSlug, workspaceSlug });
  const status = aggregate?.status ?? fanout.status;
  const cancellable = canManage && isFanoutCancellable(status);

  const timelineBars = useMemo(
    () =>
      layoutTimeline(
        timelineEntriesFrom(fanout, aggregate),
        new Date().toISOString(),
      ),
    [fanout, aggregate],
  );

  async function handleConfirmCancel() {
    setCancelling(true);
    const result = await cancelFanoutAction({
      orgSlug,
      workspaceSlug,
      fanoutId: fanout.fanoutId,
    });
    setCancelling(false);
    setConfirmCancel(false);
    if (!result.ok) {
      toast({
        title: "Cancel failed",
        description: result.error,
        type: "error",
      });
      return;
    }
    toast({
      title: "Fan-out cancelled",
      description: `${result.fanout.cancelledChildren} pending/running child run(s) were stopped.`,
      type: "success",
    });
    router.refresh();
  }

  async function handleDownloadLogs() {
    setDownloading(true);
    try {
      const res = await fetch("/api/v1/agent/subagent/logs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId, fanoutId: fanout.fanoutId }),
      });
      if (!res.ok) {
        throw new Error(`Logfile generation failed (${res.status})`);
      }
      const out = (await res.json()) as { serveUrl?: string; url?: string };
      const href = out.serveUrl ?? out.url;
      if (!href) throw new Error("Logfile response had no URL.");
      window.open(href, "_blank", "noopener,noreferrer");
    } catch (err) {
      toast({
        title: "Couldn't generate logfile",
        description: err instanceof Error ? err.message : "Unknown error.",
        type: "error",
      });
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="flex flex-col gap-5" data-testid="fleet-detail">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <Link
            href={listPath}
            className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            data-testid="fleet-detail-back-link"
          >
            <ArrowLeft className="size-3.5" aria-hidden="true" />
            All fan-outs
          </Link>
          <div className="flex items-center gap-2">
            <Badge
              variant={fanoutStatusVariant(status)}
              size="sm"
              data-testid="fleet-detail-status"
            >
              {status}
            </Badge>
            <CopyableId value={fanout.fanoutId} label="Fan-out" max={24} />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={handleDownloadLogs}
            disabled={downloading}
            data-testid="fleet-download-logs-btn"
          >
            <Download className="size-3.5" aria-hidden="true" />
            {downloading ? "Generating…" : "Download logfile"}
          </Button>
          {cancellable ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirmCancel(true)}
              data-testid="fleet-detail-cancel-btn"
            >
              Cancel fan-out
            </Button>
          ) : null}
        </div>
      </div>

      <div
        className="grid grid-cols-2 gap-3 sm:grid-cols-4"
        data-testid="fleet-detail-stats"
      >
        <StatTile
          label="Children"
          value={`${fanout.completedChildren}/${fanout.totalChildren}`}
        />
        <StatTile label="Created" value={formatTimestamp(fanout.createdAt)} />
        <StatTile label="Updated" value={formatTimestamp(fanout.updatedAt)} />
        <StatTile
          label="Conflicts"
          value={aggregate ? String(aggregate.conflicts.length) : "—"}
          warn={Boolean(aggregate && aggregate.conflicts.length > 0)}
        />
      </div>

      {/* Timeline strip — one track per child, positioned by start offset /
          duration along a shared axis. */}
      <div
        className="rounded-lg border bg-card p-3"
        data-testid="fleet-timeline"
      >
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Timeline
        </p>
        {timelineBars.length === 0 ? (
          <p className="text-sm text-muted-foreground">No child runs yet.</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {timelineBars.map((bar) => (
              <div key={bar.runId} className="flex items-center gap-2 text-xs">
                <span
                  className="w-40 shrink-0 truncate text-muted-foreground"
                  title={bar.capabilityName}
                >
                  {bar.capabilityName}
                </span>
                <div className="relative h-3 flex-1 rounded-full bg-muted">
                  <div
                    className={`absolute h-3 rounded-full ${timelineBarColor(bar.status)}`}
                    style={{
                      left: `${bar.offsetPct}%`,
                      width: `${bar.widthPct}%`,
                    }}
                    title={`${bar.status}${bar.errorReason ? `: ${bar.errorReason}` : ""}`}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Per-child row table — capability, status, duration, error, payload sizes. */}
      <Table data-testid="fleet-child-table">
        <TableHeader>
          <TableRow>
            <TableHead>Capability</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Duration</TableHead>
            <TableHead>Error</TableHead>
            <TableHead className="text-right">Input</TableHead>
            <TableHead className="text-right">Output</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {fanout.runs.map((run) => (
            <TableRow
              key={run.runId}
              interactive
              onClick={() => setSelectedRun(run)}
              data-testid={`fleet-child-row-${run.runId}`}
            >
              <TableCell>
                <div className="flex flex-col gap-1">
                  <span className="font-medium">{run.capabilityName}</span>
                  <CopyableId value={run.runId} label="ID" max={16} />
                </div>
              </TableCell>
              <TableCell>
                <Badge variant={runStatusVariant(run.status)} size="sm">
                  {run.status}
                </Badge>
              </TableCell>
              <TableCell className="text-right font-mono text-xs text-muted-foreground">
                {formatDuration(run.durationMs)}
              </TableCell>
              <TableCell className="max-w-[16rem] truncate text-xs text-destructive">
                {run.errorReason ?? ""}
              </TableCell>
              <TableCell className="text-right font-mono text-xs text-muted-foreground">
                {formatBytes(run.inputBytes)}
              </TableCell>
              <TableCell className="text-right font-mono text-xs text-muted-foreground">
                {formatBytes(run.outputBytes)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {confirmCancel ? (
        <CancelFanoutDialog
          open
          onOpenChange={setConfirmCancel}
          fanoutId={fanout.fanoutId}
          pending={cancelling}
          onConfirm={handleConfirmCancel}
        />
      ) : null}

      {selectedRun ? (
        <ChildDrawer
          open
          onOpenChange={(open) => {
            if (!open) setSelectedRun(null);
          }}
          run={selectedRun}
          fanoutId={fanout.fanoutId}
          workspaceId={workspaceId}
        />
      ) : null}
    </div>
  );
}

function StatTile({
  label,
  value,
  warn,
}: {
  label: string;
  value: string;
  warn?: boolean;
}) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p
        className={`mt-1 text-sm font-medium ${warn ? "text-warning" : "text-foreground"}`}
      >
        {value}
      </p>
    </div>
  );
}

function timelineBarColor(status: string): string {
  switch (status) {
    case "completed":
      return "bg-success";
    case "running":
      return "bg-info";
    case "failed":
      return "bg-destructive";
    default:
      return "bg-muted-foreground/60";
  }
}
