"use client";
import * as React from "react";
import { Check, Plug, ShieldCheck, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { StructuredField } from "./structured-value";
import type { ConsentResolution } from "./stream-event-types";

export interface ConsentCardProps {
  approvalId: string;
  /** Synthetic capability id: `mcp.<serverId>.<tool>`. */
  capability: string;
  serverId: string;
  toolName: string;
  inputPreview: unknown;
  expiresAt: string;
  resolution?: ConsentResolution;
  /**
   * Resolve the consent via agent.mcp.consent.resolve. `grantAllTools` pre-grants
   * every tool on the server (tool_name='*') when the user opts in.
   */
  onResolved?: (
    approvalId: string,
    decision: "granted" | "denied",
    grantAllTools: boolean,
  ) => Promise<{ ok: boolean; error?: string }>;
}

export function ConsentCard({
  approvalId,
  capability,
  serverId,
  toolName,
  inputPreview,
  expiresAt,
  resolution,
  onResolved,
}: ConsentCardProps) {
  const [pending, setPending] = React.useState<"granted" | "denied" | null>(null);
  const [optimistic, setOptimistic] = React.useState<ConsentResolution | undefined>(resolution);
  const [grantAll, setGrantAll] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const remaining = useCountdown(expiresAt, optimistic !== undefined);

  const handle = async (decision: "granted" | "denied") => {
    if (!onResolved) return;
    setError(null);
    setPending(decision);
    setOptimistic(decision);
    const res = await onResolved(approvalId, decision, decision === "granted" && grantAll);
    setPending(null);
    if (!res.ok) {
      setOptimistic(resolution);
      setError(res.error ?? "Failed to resolve consent");
    }
  };

  const settled = optimistic !== undefined;
  const expired = remaining <= 0 && !settled;

  return (
    <div
      className="rounded-xl border bg-card text-card-foreground shadow my-2 space-y-3 border-l-4 border-l-primary/40 p-4 animate-in"
      data-component="consent-card"
      data-consent-status={settled ? optimistic : expired ? "expired" : "pending"}
    >
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-primary" />
        <span className="font-semibold">Allow external tool?</span>
        <Badge variant="outline" className="font-mono">
          {toolName}
        </Badge>
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
          {expired || settled ? null : `Expires in ${formatRemaining(remaining)}`}
        </span>
      </div>

      <p className="text-xs text-muted-foreground">
        The agent wants to call <span className="font-mono">{toolName}</span> on an external MCP
        server for the first time. Granting lets it run this tool without asking again.
      </p>

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Plug className="h-3.5 w-3.5" />
        <span className="font-mono">{serverId}</span>
        <span aria-hidden>·</span>
        <span className="font-mono">{capability}</span>
      </div>

      <StructuredField label="Sample input" value={inputPreview} />

      {!settled && !expired ? (
        <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          <Checkbox
            checked={grantAll}
            onCheckedChange={(v) => setGrantAll(v === true)}
            disabled={pending !== null}
          />
          Trust every tool on this server (don&apos;t ask per tool)
        </label>
      ) : null}

      {error ? <p className="text-xs text-destructive">{error}</p> : null}

      <div className="flex items-center justify-end gap-2">
        {settled ? (
          <Badge variant={optimistic === "granted" ? "success" : "destructive"}>
            {optimistic === "granted" ? (
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
            <Button size="sm" onClick={() => handle("granted")} disabled={pending !== null}>
              {pending === "granted" ? "Allowing…" : "Allow"}
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
