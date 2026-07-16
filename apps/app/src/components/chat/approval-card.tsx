"use client";
import * as React from "react";
import { Check, CircleDollarSign, ShieldAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RiskBadge } from "./risk-badge";
import { StructuredField } from "./structured-value";
import { useChatSessionContext } from "./session/session-store";
import { formatRemaining, useCountdown } from "./use-countdown";
import type { ApprovalResolution, RiskLevel } from "./stream-event-types";

/** The budget-pause approval's inputPreview shape (stream route onPause). */
function parseBudgetPause(
  capability: string,
  inputPreview: unknown,
): { costUsd: number; limitUsd: number } | null {
  if (capability !== "budget.turn.continue") return null;
  if (typeof inputPreview !== "object" || inputPreview === null) return null;
  const obj = inputPreview as Record<string, unknown>;
  if (typeof obj.costUsd !== "number" || typeof obj.limitUsd !== "number") {
    return null;
  }
  return { costUsd: obj.costUsd, limitUsd: obj.limitUsd };
}

const usd = (v: number) => `$${v.toFixed(2)}`;

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

  // chat_ux_v2: the per-turn budget pause renders as the spec's inline card
  // — "Paused at your $2.00 cap" with Stop/Continue — instead of the generic
  // approval chrome. Continue authorizes ONE additional cap increment (the
  // guard raises the ceiling by the original limit); Stop ends the reply.
  const v2 = useChatSessionContext() !== null;
  const budgetPause = parseBudgetPause(capability, inputPreview);
  if (v2 && budgetPause) {
    return (
      <div
        role="status"
        aria-live="assertive"
        className="my-2 space-y-3 rounded-xl border border-l-4 border-l-warning/40 bg-card p-4 text-card-foreground shadow animate-in"
        data-component="budget-pause-card"
        data-approval-status={settled ? optimistic : expired ? "expired" : "pending"}
      >
        <div className="flex items-start gap-2">
          <CircleDollarSign className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <div className="min-w-0 flex-1">
            <p className="font-semibold">
              Paused at your {usd(budgetPause.limitUsd)} cap
            </p>
            <p className="text-xs text-muted-foreground">
              Spent {usd(budgetPause.costUsd)} on this reply so far
            </p>
          </div>
          <span className="text-xs tabular-nums text-muted-foreground">
            {expired || settled ? null : formatRemaining(remaining)}
          </span>
        </div>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        <div className="flex items-center justify-end gap-2">
          {settled ? (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
              {optimistic === "approved" ? (
                <>
                  <Check className="h-3 w-3 text-success" /> Continued
                </>
              ) : (
                <>
                  <X className="h-3 w-3" /> Stopped
                </>
              )}
            </span>
          ) : expired ? (
            <span className="text-xs font-medium text-muted-foreground">
              Expired — the reply stopped at the cap
            </span>
          ) : (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handle("denied")}
                disabled={pending !== null}
              >
                Stop
              </Button>
              <Button
                size="sm"
                onClick={() => handle("approved")}
                disabled={pending !== null}
              >
                {pending === "approved"
                  ? "Continuing…"
                  : `Continue for ${usd(budgetPause.limitUsd)} more`}
              </Button>
            </>
          )}
        </div>
      </div>
    );
  }

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
        <span className="text-xs text-muted-foreground">{capability}</span>
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
          {expired || settled ? null : `Expires in ${formatRemaining(remaining)}`}
        </span>
      </div>

      <StructuredField label="Proposed input" value={inputPreview} />

      {error ? <p className="text-xs text-destructive">{error}</p> : null}

      <div className="flex items-center justify-end gap-2">
        {settled ? (
          <span
            className={
              optimistic === "approved"
                ? "inline-flex items-center gap-1 text-xs font-medium text-success"
                : "inline-flex items-center gap-1 text-xs font-medium text-destructive"
            }
          >
            {optimistic === "approved" ? (
              <Check className="h-3 w-3" />
            ) : (
              <X className="h-3 w-3" />
            )}
            {optimistic}
          </span>
        ) : expired ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
            Expired
          </span>
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
