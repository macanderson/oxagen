/**
 * Requests tab — static mock UI.
 *
 * Displays JIT access request rows with requester, capability, reason, status,
 * and requested-at. Replaces the previous empty-state-only implementation.
 * ZERO server data dependencies — all data is inline mock constants.
 * Will be wired to live IAM data in OXA-XXXX (see parent ticket).
 */

import {
  Clock,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Hourglass,
} from "lucide-react";
import {
  Card,
  CardPanel,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

type RequestStatus = "pending" | "approved" | "denied" | "expired";
type ScopeKind = "org" | "workspace" | "global";

interface MockRequest {
  id: string;
  requester: string;
  requesterEmail: string;
  capabilityId: string;
  scope: ScopeKind;
  reason: string;
  status: RequestStatus;
  ttlHours: number | null;
  requestedAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

const MOCK_REQUESTS: MockRequest[] = [
  {
    id: "req_01j9xtpa",
    requester: "Priya Nair",
    requesterEmail: "priya@acme.io",
    capabilityId: "billing.manage",
    scope: "org",
    reason:
      "Need to update the payment method before our renewal on Jun 15.",
    status: "pending",
    ttlHours: 24,
    requestedAt: "Jun 5, 2026 · 09:14 AM",
    resolvedAt: null,
    resolvedBy: null,
  },
  {
    id: "req_02j9xtpb",
    requester: "James Park",
    requesterEmail: "james@acme.io",
    capabilityId: "infra.deploy",
    scope: "workspace",
    reason:
      "Emergency hotfix deployment for the API rate-limit regression — CI is blocked.",
    status: "approved",
    ttlHours: 4,
    requestedAt: "Jun 4, 2026 · 03:45 PM",
    resolvedAt: "Jun 4, 2026 · 03:52 PM",
    resolvedBy: "Mac Anderson",
  },
  {
    id: "req_03j9xtpc",
    requester: "data-sync-worker",
    requesterEmail: "svc:data-sync-worker",
    capabilityId: "knowledge.ingest",
    scope: "workspace",
    reason:
      "Batch re-ingest for the Notion connector after schema migration.",
    status: "approved",
    ttlHours: 8,
    requestedAt: "Jun 3, 2026 · 11:00 AM",
    resolvedAt: "Jun 3, 2026 · 11:03 AM",
    resolvedBy: "Sarah Chen",
  },
  {
    id: "req_04j9xtpd",
    requester: "Lena Brandt",
    requesterEmail: "lena@acme.io",
    capabilityId: "content.generate",
    scope: "org",
    reason:
      "Creating a product launch kit with video generation for the Q2 campaign.",
    status: "denied",
    ttlHours: null,
    requestedAt: "Jun 2, 2026 · 02:30 PM",
    resolvedAt: "Jun 2, 2026 · 05:10 PM",
    resolvedBy: "Mac Anderson",
  },
  {
    id: "req_05j9xtpe",
    requester: "research-agent-v2",
    requesterEmail: "agent:research-agent-v2",
    capabilityId: "web.search",
    scope: "workspace",
    reason:
      "Competitive analysis run — needs live web access for the market-research playbook.",
    status: "expired",
    ttlHours: 2,
    requestedAt: "May 31, 2026 · 08:00 AM",
    resolvedAt: null,
    resolvedBy: null,
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STATUS_CONFIG: Record<
  RequestStatus,
  {
    label: string;
    variant: "default" | "destructive" | "muted" | "outline" | "warning";
    icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
  }
> = {
  pending: { label: "Pending", variant: "warning", icon: Hourglass },
  approved: { label: "Approved", variant: "default", icon: CheckCircle2 },
  denied: { label: "Denied", variant: "destructive", icon: XCircle },
  expired: { label: "Expired", variant: "outline", icon: AlertTriangle },
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AccessRequestsPage() {
  const pending = MOCK_REQUESTS.filter((r) => r.status === "pending");
  const past = MOCK_REQUESTS.filter((r) => r.status !== "pending");

  return (
    <div className="flex flex-col gap-6">
      {/* Preview pill */}
      <p className="text-[11px] text-muted-foreground/60 font-medium">
        Preview &middot; not yet wired to live data
      </p>

      {/* Pending requests */}
      {pending.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-border/60 bg-muted/60">
                <Clock
                  className="h-4 w-4 text-muted-foreground"
                  aria-hidden="true"
                />
              </span>
              <div>
                <CardTitle>
                  Pending requests{" "}
                  <span className="ml-1.5 inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground">
                    {pending.length}
                  </span>
                </CardTitle>
                <CardDescription>
                  JIT access requests awaiting your review.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardPanel>
            <div className="flex flex-col gap-2">
              {pending.map((r) => (
                <RequestRow key={r.id} request={r} />
              ))}
            </div>
          </CardPanel>
        </Card>
      )}

      {/* History */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-border/60 bg-muted/60">
              <CheckCircle2
                className="h-4 w-4 text-muted-foreground"
                aria-hidden="true"
              />
            </span>
            <div>
              <CardTitle>Request history</CardTitle>
              <CardDescription>
                Past JIT access requests — approved, denied, and expired.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardPanel>
          <div className="flex flex-col gap-2">
            {past.map((r) => (
              <RequestRow key={r.id} request={r} />
            ))}
          </div>
        </CardPanel>
      </Card>
    </div>
  );
}

function RequestRow({ request: r }: { request: MockRequest }) {
  const cfg = STATUS_CONFIG[r.status];
  const StatusIcon = cfg.icon;

  return (
    <div className="rounded-xl border border-border/50 bg-muted/20 px-4 py-3">
      <div className="flex flex-wrap items-start gap-3">
        {/* Left: requester + capability + reason */}
        <div className="flex flex-1 flex-col gap-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-foreground">
              {r.requester}
            </span>
            <span className="text-xs text-muted-foreground">
              {r.requesterEmail}
            </span>
          </div>
          <p className="font-mono text-xs text-muted-foreground">
            {r.capabilityId}{" "}
            <span className="font-sans capitalize text-muted-foreground/70">
              ({r.scope})
            </span>
            {r.ttlHours != null && (
              <span className="font-sans text-muted-foreground/70">
                {" "}
                &middot; TTL {r.ttlHours}h
              </span>
            )}
          </p>
          <p className="text-xs text-muted-foreground/80 italic leading-snug mt-0.5">
            &ldquo;{r.reason}&rdquo;
          </p>
          <p className="text-[11px] text-muted-foreground/60 mt-0.5">
            Requested {r.requestedAt}
            {r.resolvedAt && r.resolvedBy && (
              <>
                {" "}
                &middot; {cfg.label.toLowerCase()} by {r.resolvedBy} at{" "}
                {r.resolvedAt}
              </>
            )}
          </p>
        </div>

        {/* Right: status badge */}
        <Badge variant={cfg.variant} className="shrink-0 text-xs mt-0.5">
          <StatusIcon className="mr-1 h-3 w-3" aria-hidden="true" />
          {cfg.label}
        </Badge>
      </div>
    </div>
  );
}
