"use client";
import * as React from "react";
import { Check, ShieldAlert, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RiskBadge } from "./risk-badge";
import { safeJson } from "./tool-call-card";
import type { ApprovalResolution, RiskLevel } from "./stream-event-types";

export interface ApprovalCardProps {
  approvalId: string;
  capability: string;
  inputPreview: unknown;
  riskLevel: RiskLevel;
  expiresAt: string;
  resolution?: ApprovalResolution;
  onResolved?: (
    approvalId: string,
    decision: "approved" | "denied",
  ) => Promise<{ ok: boolean; error?: string }>;
}

export function ApprovalCard({
  approvalId,
  capability,
  inputPreview,
  riskLevel,
  expiresAt,
  resolution,
  onResolved,
}: ApprovalCardProps) {
  const [pending, setPending] = React.useState<"approved" | "denied" | null>(null);
  const [optimistic, setOptimistic] = React.useState<ApprovalResolution | undefined>(resolution);
  const [error, setError] = React.useState<string | null>(null);
  const remaining = useCountdown(expiresAt, optimistic !== undefined);

  const handle = async (decision: "approved" | "denied") => {
    if (!onResolved) return;
    setError(null);
    setPending(decision);
    setOptimistic(decision);
    const res = await onResolved(approvalId, decision);
    setPending(null);
    if (!res.ok) {
      setOptimistic(resolution);
      setError(res.error ?? "Failed to resolve approval");
    }
  };

  const settled = optimistic !== undefined;
  const expired = remaining <= 0 && !settled;

  return (
    <div
      className="rounded-xl border bg-card text-card-foreground shadow my-2 space-y-3 border-l-4 border-l-warning/40 p-4 animate-in"
      data-component="approval-card"
      data-approval-status={settled ? optimistic : expired ? "expired" : "pending"}
    >
      <div className="flex items-center gap-2">
        <ShieldAlert className="h-4 w-4 text-warning" />
        <span className="font-semibold">Approval required</span>
        <RiskBadge risk={riskLevel} />
        <Badge variant="outline" className="font-mono">
          {capability}
        </Badge>
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
          {expired || settled ? null : `Expires in ${formatRemaining(remaining)}`}
        </span>
      </div>

      <div>
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Proposed input
        </div>
        <pre className="overflow-x-auto rounded-lg bg-muted/40 p-2 font-mono text-xs">
          {safeJson(inputPreview)}
        </pre>
      </div>

      {error ? <p className="text-xs text-destructive">{error}</p> : null}

      <div className="flex items-center justify-end gap-2">
        {settled ? (
          <Badge variant={optimistic === "approved" ? "success" : "destructive"}>
            {optimistic === "approved" ? (
              <Check className="mr-1 h-3 w-3" />
            ) : (
              <X className="mr-1 h-3 w-3" />
            )}
            {optimistic}
          </Badge>
        ) : expired ? (
          <Badge variant="muted">Expired</Badge>
        ) : (
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => handle("denied")}
              disabled={pending !== null}
            >
              Deny
            </Button>
            <Button
              size="sm"
              onClick={() => handle("approved")}
              disabled={pending !== null}
            >
              {pending === "approved" ? "Approving…" : "Approve"}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function useCountdown(expiresAt: string, stop: boolean): number {
  const target = React.useMemo(() => new Date(expiresAt).getTime(), [expiresAt]);
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    // Don't tick once the card is settled or already past its deadline — and
    // self-clear the moment the deadline is crossed. Without this the interval
    // re-renders a resolved/expired card every second for the rest of the
    // conversation's life (mirrors useElapsed in background-task-tray).
    if (stop || Date.now() >= target) return;
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= target) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [stop, target]);
  return Math.max(0, target - now);
}

function formatRemaining(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}
