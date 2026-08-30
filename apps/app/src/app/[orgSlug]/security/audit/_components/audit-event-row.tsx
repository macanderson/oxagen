"use client";

// audit-event-row.tsx — a single audit row that expands to a forensic
// drill-down (ip / user agent / request id / capability / workspace / actor).

import * as React from "react";
import {
  ChevronRight,
  CheckCircle2,
  XCircle,
  AlertTriangle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn, formatDateTimeWithSeconds } from "@/lib/utils";

export interface AuditEventRowData {
  id: string;
  occurredAt: string; // ISO (serialized for the client boundary)
  eventType: string;
  outcome: string;
  actorUserId: string | null;
  /** Resolved display name for the actor (null when unknown/system). */
  actorName: string | null;
  workspaceId: string | null;
  capability: string | null;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

const OUTCOME_VARIANT: Record<
  string,
  "default" | "destructive" | "muted" | "outline"
> = {
  allow: "default",
  success: "default",
  deny: "destructive",
  error: "muted",
};

function OutcomeIcon({ outcome }: { outcome: string }) {
  if (outcome === "allow" || outcome === "success")
    return <CheckCircle2 className="mr-1 h-3 w-3" aria-hidden="true" />;
  if (outcome === "deny")
    return <XCircle className="mr-1 h-3 w-3" aria-hidden="true" />;
  return <AlertTriangle className="mr-1 h-3 w-3" aria-hidden="true" />;
}

function Detail({
  label,
  value,
  mono,
}: {
  label: string;
  value: string | null;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span
        className={cn("text-xs text-foreground break-all", mono && "font-mono")}
      >
        {value && value.length > 0 ? value : "—"}
      </span>
    </div>
  );
}

export function AuditEventRow({ row }: { row: AuditEventRowData }) {
  const [open, setOpen] = React.useState(false);

  return (
    <div className="rounded-xl border border-border/60 bg-muted/30">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset rounded-xl"
      >
        <ChevronRight
          className={cn(
            "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
          aria-hidden="true"
        />
        <div className="flex flex-1 flex-col gap-0.5 min-w-0">
          <p className="font-mono text-xs font-medium text-foreground truncate">
            {row.eventType}
            {row.capability ? ` · ${row.capability}` : ""}
          </p>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{formatDateTimeWithSeconds(row.occurredAt)}</span>
            {row.ip && <span className="font-mono">{row.ip}</span>}
          </div>
        </div>
        <Badge
          variant={OUTCOME_VARIANT[row.outcome] ?? "outline"}
          className="shrink-0 text-xs"
        >
          <OutcomeIcon outcome={row.outcome} />
          {row.outcome}
        </Badge>
      </button>

      {open && (
        <div className="grid grid-cols-2 gap-3 border-t border-border/60 px-4 py-3 sm:grid-cols-3">
          <Detail label="Event ID" value={row.id} mono />
          <Detail
            label="Actor"
            value={row.actorName ?? row.actorUserId}
            mono={!row.actorName}
          />
          <Detail label="Workspace" value={row.workspaceId} mono />
          <Detail label="Capability" value={row.capability} mono />
          <Detail label="IP address" value={row.ip} mono />
          <Detail label="Request ID" value={row.requestId} mono />
          <div className="col-span-2 sm:col-span-3">
            <Detail label="User agent" value={row.userAgent} />
          </div>
        </div>
      )}
    </div>
  );
}
