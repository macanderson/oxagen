import { Hourglass, CheckCircle2, XCircle, Clock } from "lucide-react";
import { Panel } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";

// ---------------------------------------------------------------------------
// Static mock — no DB dependency (pure presentational; OXA-XXXX to wire)
// ---------------------------------------------------------------------------

interface AccessRequest {
  id: string;
  requesterName: string;
  requesterEmail: string | null;
  capability: string;
  scope: string;
  justification: string;
  status: "pending" | "approved" | "denied" | "expired";
  duration: string;
  requestedAt: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
}

const MOCK_REQUESTS: AccessRequest[] = [
  {
    id: "req_01",
    requesterName: "Carol Martinez",
    requesterEmail: "carol@acme.co",
    capability: "billing.invoice.export",
    scope: "org:acme",
    justification: "Need to pull Q2 invoices for finance audit.",
    status: "pending",
    duration: "4 hours",
    requestedAt: "2026-06-25T09:14:00Z",
    reviewedBy: null,
    reviewedAt: null,
  },
  {
    id: "req_02",
    requesterName: "Dan Williams",
    requesterEmail: "dan@acme.co",
    capability: "knowledge.source.delete",
    scope: "workspace:ws_staging",
    justification: "Cleaning up stale test sources before sprint demo.",
    status: "pending",
    duration: "1 hour",
    requestedAt: "2026-06-25T08:30:00Z",
    reviewedBy: null,
    reviewedAt: null,
  },
  {
    id: "req_03",
    requesterName: "Bob Chen",
    requesterEmail: "bob@acme.co",
    capability: "automation.agent.execute",
    scope: "workspace:ws_prod",
    justification: "Need to run the quarterly report agent manually.",
    status: "approved",
    duration: "2 hours",
    requestedAt: "2026-06-24T14:00:00Z",
    reviewedBy: "alice@acme.co",
    reviewedAt: "2026-06-24T14:12:00Z",
  },
  {
    id: "req_04",
    requesterName: "intern@acme.co",
    requesterEmail: "intern@acme.co",
    capability: "settings.org.update",
    scope: "org:acme",
    justification: "Want to update the org display name.",
    status: "denied",
    duration: "30 minutes",
    requestedAt: "2026-06-23T11:00:00Z",
    reviewedBy: "alice@acme.co",
    reviewedAt: "2026-06-23T11:45:00Z",
  },
  {
    id: "req_05",
    requesterName: "Carol Martinez",
    requesterEmail: "carol@acme.co",
    capability: "knowledge.source.create",
    scope: "workspace:ws_research",
    justification:
      "Adding competitor analysis documents to research workspace.",
    status: "approved",
    duration: "8 hours",
    requestedAt: "2026-06-22T10:00:00Z",
    reviewedBy: "bob@acme.co",
    reviewedAt: "2026-06-22T10:05:00Z",
  },
  {
    id: "req_06",
    requesterName: "data-pipeline-svc",
    requesterEmail: null,
    capability: "knowledge.source.ingest",
    scope: "workspace:ws_prod",
    justification: "Emergency re-ingest after pipeline failure.",
    status: "expired",
    duration: "1 hour",
    requestedAt: "2026-06-20T16:00:00Z",
    reviewedBy: null,
    reviewedAt: null,
  },
];

const STATUS_CONFIG: Record<
  AccessRequest["status"],
  {
    icon: React.ComponentType<{ className?: string }>;
    badgeClass: string;
    label: string;
  }
> = {
  pending: {
    icon: Clock,
    badgeClass: "bg-warning/10 text-warning",
    label: "Pending",
  },
  approved: {
    icon: CheckCircle2,
    badgeClass: "bg-success/10 text-success",
    label: "Approved",
  },
  denied: {
    icon: XCircle,
    badgeClass: "bg-destructive/10 text-destructive",
    label: "Denied",
  },
  expired: {
    icon: Hourglass,
    badgeClass: "bg-muted text-muted-foreground",
    label: "Expired",
  },
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AccessRequestsPage() {
  const pendingRequests = MOCK_REQUESTS.filter((r) => r.status === "pending");
  const resolvedRequests = MOCK_REQUESTS.filter((r) => r.status !== "pending");

  return (
    <div className="flex flex-col gap-6">
      {/* OXA-XXXX indicator */}
      <div className="inline-flex w-fit items-center gap-1.5 rounded-full border border-border/40 bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground">
        <div className="h-1.5 w-1.5 rounded-full bg-muted-foreground/50" />
        OXA-XXXX · not yet wired to live data
      </div>

      {/* Pending requests */}
      <Panel title={`Pending Requests (${pendingRequests.length})`}>
        <p className="mb-4 text-sm text-muted-foreground">
          Time-bound capability requests awaiting review. Approve or deny to
          grant just-in-time access.
        </p>

        {pendingRequests.length === 0 ? (
          <p className="text-sm text-muted-foreground">No pending requests.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {pendingRequests.map((req) => (
              <RequestCard key={req.id} request={req} />
            ))}
          </div>
        )}
      </Panel>

      {/* History */}
      <Panel title="History">
        <div className="overflow-hidden rounded-lg border border-border/60">
          <table className="w-full text-sm" aria-label="Access request history">
            <thead>
              <tr className="border-b border-border/60 bg-muted/30">
                <th className="py-2.5 pl-4 pr-3 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Requester
                </th>
                <th className="py-2.5 px-3 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Capability
                </th>
                <th className="py-2.5 px-3 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Status
                </th>
                <th className="py-2.5 px-3 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Duration
                </th>
                <th className="py-2.5 px-3 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Reviewed By
                </th>
                <th className="py-2.5 pl-3 pr-4 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Requested
                </th>
              </tr>
            </thead>
            <tbody>
              {resolvedRequests.map((req) => {
                const cfg = STATUS_CONFIG[req.status];
                const StatusIcon = cfg.icon;
                return (
                  <tr
                    key={req.id}
                    className="border-b border-border/40 last:border-b-0 hover:bg-muted/20 transition-colors"
                  >
                    <td className="py-3 pl-4 pr-3">
                      <span className="text-sm font-medium text-foreground">
                        {req.requesterName}
                      </span>
                    </td>
                    <td className="py-3 px-3">
                      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">
                        {req.capability}
                      </code>
                    </td>
                    <td className="py-3 px-3">
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${cfg.badgeClass}`}
                      >
                        <StatusIcon className="h-3 w-3" aria-hidden="true" />
                        {cfg.label}
                      </span>
                    </td>
                    <td className="py-3 px-3 text-xs text-muted-foreground">
                      {req.duration}
                    </td>
                    <td className="py-3 px-3 text-xs text-muted-foreground">
                      {req.reviewedBy ?? "—"}
                    </td>
                    <td className="py-3 pl-3 pr-4 text-xs text-muted-foreground whitespace-nowrap">
                      {new Date(req.requestedAt).toLocaleDateString()}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pending request card (expanded view with justification + action buttons)
// ---------------------------------------------------------------------------

function RequestCard({ request }: { request: AccessRequest }) {
  return (
    <div className="rounded-xl border border-warning/30 bg-warning/5 px-4 py-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1.5 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-foreground">
              {request.requesterName}
            </span>
            <span className="text-xs text-muted-foreground">
              {request.requesterEmail}
            </span>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">
              {request.capability}
            </code>
            <span className="text-xs text-muted-foreground font-mono">
              {request.scope}
            </span>
            <Badge variant="outline" className="text-[10px]">
              {request.duration}
            </Badge>
          </div>

          <p className="mt-1 text-xs text-muted-foreground leading-snug">
            <span className="font-medium text-foreground/80">
              Justification:
            </span>{" "}
            {request.justification}
          </p>
        </div>

        {/* Action buttons (disabled for mock) */}
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            disabled
            className="inline-flex items-center gap-1 rounded-md border border-success/40 bg-success/10 px-2.5 py-1 text-[11px] font-medium text-success opacity-60 cursor-not-allowed"
            aria-label="Approve request"
          >
            <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
            Approve
          </button>
          <button
            type="button"
            disabled
            className="inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1 text-[11px] font-medium text-destructive opacity-60 cursor-not-allowed"
            aria-label="Deny request"
          >
            <XCircle className="h-3 w-3" aria-hidden="true" />
            Deny
          </button>
        </div>
      </div>
    </div>
  );
}
