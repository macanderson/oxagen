"use client";
/**
 * fleet-list-client.tsx — the Fleet list table: one row per subagent fan-out.
 *
 * Row click navigates to the fan-out detail via the `?fanout=<id>` query
 * param (no nested route — routes.ts stays frozen). Each non-terminal
 * fan-out (pending/running) carries an inline Cancel action, gated on
 * `canManage` and backed by cancelFanoutAction with a confirm dialog.
 *
 * Total cost is not shown: none of list_subagent_fanouts, get_subagent_fanout,
 * or aggregate_subagents expose a per-fanout rolled-up cost figure today (a
 * backend gap — see the builder's final report). The column renders "—".
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Network } from "lucide-react";
import type { AgentSubagentFanoutListOutput } from "@oxagen/oxagen/contracts/agent.subagent_fanout.list";
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
import { EmptyState } from "@/app/[orgSlug]/[workspaceSlug]/_shared/components";
import { CopyableId } from "@/components/knowledge/graph-explorer/copyable-id";
import { formatTimestamp, timeAgo } from "@/components/activity/format";
import { workspace } from "@/lib/routes";
import { cancelFanoutAction } from "./actions";
import { CancelFanoutDialog } from "./cancel-fanout-dialog";
import { fanoutStatusVariant, isFanoutCancellable } from "./status";

type Fanout = AgentSubagentFanoutListOutput["fanouts"][number];

export interface FleetListClientProps {
  fanouts: Fanout[];
  orgSlug: string;
  workspaceSlug: string;
  canManage: boolean;
}

export function FleetListClient({
  fanouts,
  orgSlug,
  workspaceSlug,
  canManage,
}: FleetListClientProps) {
  const router = useRouter();
  const { add: toast } = useToast();
  const [cancelTarget, setCancelTarget] = useState<Fanout | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const basePath = workspace.activity.fleet({ orgSlug, workspaceSlug });

  async function confirmCancel() {
    if (!cancelTarget) return;
    setCancelling(true);
    const result = await cancelFanoutAction({
      orgSlug,
      workspaceSlug,
      fanoutId: cancelTarget.fanoutId,
    });
    setCancelling(false);
    setCancelTarget(null);
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

  if (fanouts.length === 0) {
    return (
      <div data-testid="fleet-empty-state">
        <EmptyState
          icon={Network}
          title="No fan-outs yet"
          description="This workspace hasn't dispatched a subagent fan-out. Fan-out is triggered from an agent definition using subagent dispatch (agent.subagent.dispatch) — parallel research, fan-out review, or swarm work."
          className="rounded-lg border bg-card"
        />
      </div>
    );
  }

  return (
    <div data-testid="fleet-list">
      <Table data-testid="fleet-list-table">
        <TableHeader>
          <TableRow>
            <TableHead>Fan-out</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Children</TableHead>
            <TableHead className="text-right">Started</TableHead>
            <TableHead className="text-right">Total cost</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {fanouts.map((fanout) => {
            const cancellable = canManage && isFanoutCancellable(fanout.status);
            return (
              <TableRow
                key={fanout.fanoutId}
                interactive
                data-testid={`fleet-row-${fanout.fanoutId}`}
              >
                <TableCell>
                  {/* The navigable label is a plain link (not nested inside the
                      copy-to-clipboard buttons below — a button-in-anchor would
                      be invalid markup and double-fire on click). */}
                  <Link
                    href={`${basePath}?fanout=${encodeURIComponent(fanout.fanoutId)}`}
                    className="font-medium text-foreground hover:underline"
                    data-testid={`fleet-row-link-${fanout.fanoutId}`}
                  >
                    Fan-out {fanout.fanoutId.slice(-8)}
                  </Link>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    <CopyableId value={fanout.fanoutId} label="ID" max={20} />
                    <span>parent</span>
                    <CopyableId value={fanout.parentMessageId} max={16} />
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant={fanoutStatusVariant(fanout.status)} size="sm">
                    {fanout.status}
                  </Badge>
                </TableCell>
                <TableCell className="text-right font-mono text-xs text-muted-foreground">
                  {fanout.completedChildren}/{fanout.totalChildren}
                </TableCell>
                <TableCell
                  className="text-right text-xs text-muted-foreground"
                  title={formatTimestamp(fanout.createdAt)}
                >
                  {timeAgo(fanout.createdAt)}
                </TableCell>
                <TableCell className="text-right font-mono text-xs text-muted-foreground">
                  —
                </TableCell>
                <TableCell className="text-right">
                  {cancellable ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setCancelTarget(fanout);
                      }}
                      data-testid={`fleet-cancel-btn-${fanout.fanoutId}`}
                    >
                      Cancel
                    </Button>
                  ) : null}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {cancelTarget ? (
        <CancelFanoutDialog
          open
          onOpenChange={(open) => {
            if (!open) setCancelTarget(null);
          }}
          fanoutId={cancelTarget.fanoutId}
          pending={cancelling}
          onConfirm={confirmCancel}
        />
      ) : null}
    </div>
  );
}
