import {
  ScrollText,
  User,
  Bot,
  Key,
  CheckCircle2,
  XCircle,
  Hash,
  type LucideIcon,
} from "lucide-react";
import { queryAuditLogAction } from "@/lib/actions/audit";

export const dynamic = "force-dynamic";

// ── Types ─────────────────────────────────────────────────────────────────────

type AuditOutcome = "success" | "allow" | "deny" | "error";

// ── Helpers ───────────────────────────────────────────────────────────────────

const OUTCOME_CONFIG: Record<
  AuditOutcome,
  { icon: LucideIcon; className: string; label: string }
> = {
  success: { icon: CheckCircle2, className: "text-success", label: "Success" },
  allow: { icon: CheckCircle2, className: "text-success", label: "Allow" },
  deny: { icon: XCircle, className: "text-warning", label: "Denied" },
  error: { icon: XCircle, className: "text-error", label: "Error" },
};

function principalIcon(actorUserId: string | null): LucideIcon {
  if (!actorUserId) return Bot;
  if (actorUserId.startsWith("aky_")) return Key;
  return User;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function ActivityAuditPage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;

  const data = await queryAuditLogAction({
    orgSlug,
    workspaceSlug,
    source: "all",
    limit: 50,
    offset: 0,
  }).catch(() => ({
    events: [],
    total: 0,
    hasMore: false,
    limit: 50,
    offset: 0,
  }));

  const successCount = data.events.filter(
    (e) => e.outcome === "success" || e.outcome === "allow",
  ).length;
  const deniedCount = data.events.filter((e) => e.outcome === "deny").length;
  const errorCount = data.events.filter((e) => e.outcome === "error").length;

  return (
    <div className="flex flex-col gap-5 max-w-3xl">
      {/* Section heading */}
      <div className="flex items-start gap-3">
        <ScrollText
          className="mt-0.5 h-5 w-5 flex-shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <div>
          <p className="text-sm font-semibold text-foreground">Audit log</p>
          <p className="text-xs text-muted-foreground">
            Workspace-scoped slice of the org-wide audit log. Every capability
            invocation is recorded with principal, outcome, and event type.
          </p>
        </div>
      </div>

      {/* Stats strip */}
      <div className="grid grid-cols-3 gap-3">
        <div className="flex flex-col gap-0.5 rounded-lg border border-border/60 bg-card px-4 py-3">
          <span className="text-xs text-muted-foreground">Successful</span>
          <span className="text-xl font-semibold tabular-nums text-foreground">
            {successCount}
          </span>
        </div>
        <div className="flex flex-col gap-0.5 rounded-lg border border-border/60 bg-card px-4 py-3">
          <span className="text-xs text-muted-foreground">Denied</span>
          <span className="text-xl font-semibold tabular-nums text-foreground">
            {deniedCount}
          </span>
        </div>
        <div className="flex flex-col gap-0.5 rounded-lg border border-border/60 bg-card px-4 py-3">
          <span className="text-xs text-muted-foreground">Errors</span>
          <span className="text-xl font-semibold tabular-nums text-foreground">
            {errorCount}
          </span>
        </div>
      </div>

      {/* Audit table */}
      <div className="rounded-lg border border-border/60">
        <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
          <ScrollText
            className="h-4 w-4 text-muted-foreground"
            aria-hidden="true"
          />
          <span className="text-sm font-semibold text-foreground">
            Recent events
          </span>
          <span className="ml-auto text-xs text-muted-foreground">
            {data.total} shown{data.hasMore ? " · more available" : ""}
          </span>
        </div>
        <ul className="divide-y divide-border/40" role="list">
          {data.events.length === 0 ? (
            <li className="px-4 py-6 text-center text-sm text-muted-foreground">
              No audit events recorded yet for this workspace.
            </li>
          ) : (
            data.events.map((event, i) => {
              const outcome =
                OUTCOME_CONFIG[(event.outcome as AuditOutcome) ?? "success"] ??
                OUTCOME_CONFIG.success;
              const OutcomeIcon = outcome.icon;
              const PrincipalIcon = principalIcon(event.actorUserId);

              return (
                <li
                  key={`${event.occurredAt}-${i}`}
                  className="flex items-start gap-3 px-4 py-3.5 hover:bg-muted/30 transition-colors"
                >
                  <OutcomeIcon
                    className={`mt-0.5 h-4 w-4 flex-shrink-0 ${outcome.className}`}
                    aria-label={outcome.label}
                  />
                  <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                    <code className="text-xs font-mono font-medium text-foreground">
                      {event.capability ?? event.eventType}
                    </code>
                    <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <PrincipalIcon className="h-3 w-3" aria-hidden="true" />
                        {event.actorUserId ?? "System"}
                      </span>
                      <span className="flex items-center gap-1">
                        <Hash className="h-3 w-3" aria-hidden="true" />
                        {event.source}
                      </span>
                      <span>{formatTime(event.occurredAt)}</span>
                      {event.requestId && (
                        <span className="font-mono text-[10px]">
                          {event.requestId.slice(0, 8)}
                        </span>
                      )}
                    </div>
                  </div>
                </li>
              );
            })
          )}
        </ul>
      </div>
    </div>
  );
}
