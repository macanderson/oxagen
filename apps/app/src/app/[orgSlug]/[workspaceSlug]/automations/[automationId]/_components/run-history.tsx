/**
 * run-history.tsx — the automation's recent runs, the audit-record link of the
 * accountability chain made visible per-automation. Read-only; newest first.
 *
 * Data is the 20 most-recent playbook_runs returned by automation.get. Until an
 * automation has fired, this shows "Never fired".
 */
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import type { AutomationGetOutput } from "@oxagen/oxagen/contracts/automation.get";

export interface RunHistoryProps {
  runs: AutomationGetOutput["runs"];
}

function statusVariant(
  status: string,
): "success-soft" | "error-soft" | "warning-soft" | "info-soft" | "muted" {
  switch (status) {
    case "completed":
      return "success-soft";
    case "failed":
      return "error-soft";
    case "cancelled":
      return "muted";
    case "running":
    case "pending":
      return "info-soft";
    case "waiting_approval":
    case "paused":
      return "warning-soft";
    default:
      return "muted";
  }
}

function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

function formatDuration(
  startedAt: string | null,
  completedAt: string | null,
): string {
  if (!startedAt || !completedAt) return "—";
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (Number.isNaN(ms) || ms < 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 100) / 10;
  return `${s}s`;
}

export function RunHistory({ runs }: RunHistoryProps) {
  return (
    <Card className="p-4">
      <h2 className="mb-3 text-sm font-semibold text-foreground">
        Run history
      </h2>

      {runs.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Never fired. Runs will appear here once this automation is triggered.
        </p>
      ) : (
        <Table data-testid="run-history-table">
          <TableHeader>
            <TableRow>
              <TableHead>Started</TableHead>
              <TableHead>Source</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Duration</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((run) => (
              <TableRow key={run.id}>
                <TableCell className="text-sm">
                  {formatWhen(run.startedAt ?? run.createdAt)}
                </TableCell>
                <TableCell>
                  <Badge variant="muted" size="sm">
                    {run.source}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Badge variant={statusVariant(run.status)} size="sm">
                    {run.status}
                  </Badge>
                </TableCell>
                <TableCell className="text-right text-sm text-muted-foreground">
                  {formatDuration(run.startedAt, run.completedAt)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}
