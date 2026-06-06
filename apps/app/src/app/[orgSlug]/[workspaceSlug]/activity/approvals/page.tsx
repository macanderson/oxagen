/**
 * page.tsx — Workspace → Activity → Approvals (static mock).
 *
 * Static presentational mock — zero withTenantDb / invoke() dependencies.
 * Wire-up target: activity.approvals.list + activity.approvals.resolve
 *                 capabilities — human-in-the-loop queue (Postgres).
 *
 * Shows pending, approved, and rejected plan approvals and capability
 * checkpoints from agents configured with require-approval.
 */
import {
  Info,
  CheckSquare,
  Check,
  X,
  Clock,
  Bot,
  AlertCircle,
  ChevronRight,
} from "lucide-react";

// ── Mock data ─────────────────────────────────────────────────────────────────

type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";
type ApprovalKind = "plan" | "tool_call" | "data_access";

interface MockApproval {
  id: string;
  kind: ApprovalKind;
  status: ApprovalStatus;
  agentName: string;
  summary: string;
  detail: string;
  requestedAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  expiresAt: string | null;
}

const MOCK_APPROVALS: MockApproval[] = [
  {
    id: "apr-01",
    kind: "plan",
    status: "pending",
    agentName: "Data Ingestion Agent",
    summary: "Sync 4,820 records from oxagen-monorepo GitHub",
    detail: "Agent plans to read all commits, PRs, and issues from the oxagen-monorepo repository using the GitHub connector and write entity records to the knowledge graph. Estimated ~2 credits.",
    requestedAt: "2026-06-06 14:55",
    resolvedAt: null,
    resolvedBy: null,
    expiresAt: "2026-06-07 14:55",
  },
  {
    id: "apr-02",
    kind: "tool_call",
    status: "pending",
    agentName: "Billing Audit Agent",
    summary: "Execute Stripe API: list all invoices",
    detail: "Agent requested permission to call stripe.invoices.list with a date range of 2025-01-01 to 2026-06-06, limit 500. Read-only. Will not create or modify any Stripe resources.",
    requestedAt: "2026-06-06 13:40",
    resolvedAt: null,
    resolvedBy: null,
    expiresAt: "2026-06-07 13:40",
  },
  {
    id: "apr-03",
    kind: "data_access",
    status: "approved",
    agentName: "Research Agent",
    summary: "Access Google Drive — Product Specs folder",
    detail: "Agent requested read access to the Product Specs folder in the connected Google Drive source to analyse competitor research documents.",
    requestedAt: "2026-06-05 10:20",
    resolvedAt: "2026-06-05 10:35",
    resolvedBy: "Mac Anderson",
    expiresAt: null,
  },
  {
    id: "apr-04",
    kind: "plan",
    status: "rejected",
    agentName: "Automation Agent",
    summary: "Delete 12 stale workflow triggers",
    detail: "Agent proposed deleting triggers that have not fired in 90+ days. Rejected — requires manual review before deletion.",
    requestedAt: "2026-06-04 16:10",
    resolvedAt: "2026-06-04 16:22",
    resolvedBy: "Mac Anderson",
    expiresAt: null,
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<ApprovalStatus, { label: string; className: string; badgeClass: string }> = {
  pending: {
    label: "Pending",
    className: "text-amber-600 dark:text-amber-400",
    badgeClass: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  },
  approved: {
    label: "Approved",
    className: "text-emerald-600 dark:text-emerald-400",
    badgeClass: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  },
  rejected: {
    label: "Rejected",
    className: "text-red-500 dark:text-red-400",
    badgeClass: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
  },
  expired: {
    label: "Expired",
    className: "text-muted-foreground",
    badgeClass: "bg-muted text-muted-foreground",
  },
};

const KIND_LABELS: Record<ApprovalKind, string> = {
  plan: "Plan",
  tool_call: "Tool call",
  data_access: "Data access",
};

// ── Sub-components ─────────────────────────────────────────────────────────────

function ApprovalCard({ approval }: { approval: MockApproval }) {
  const status = STATUS_CONFIG[approval.status];
  const isPending = approval.status === "pending";
  return (
    <div
      className={`flex flex-col gap-3 rounded-lg border px-4 py-4 ${
        isPending ? "border-amber-200/60 dark:border-amber-900/40" : "border-border/60"
      } bg-card`}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${status.badgeClass}`}>
              {status.label}
            </span>
            <span className="rounded border border-border/50 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {KIND_LABELS[approval.kind]}
            </span>
          </div>
          <p className="mt-1 text-sm font-semibold text-foreground">{approval.summary}</p>
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Bot className="h-3 w-3" aria-hidden="true" />
            {approval.agentName} · {approval.requestedAt}
          </span>
        </div>
        {isPending && (
          <div className="flex flex-shrink-0 items-center gap-2">
            <button
              type="button"
              className="flex items-center gap-1 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100 transition-colors dark:border-red-900/40 dark:bg-red-950/20 dark:text-red-400"
            >
              <X className="h-3 w-3" aria-hidden="true" />
              Reject
            </button>
            <button
              type="button"
              className="flex items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              <Check className="h-3 w-3" aria-hidden="true" />
              Approve
            </button>
          </div>
        )}
      </div>

      {/* Detail */}
      <p className="text-xs text-muted-foreground leading-relaxed">{approval.detail}</p>

      {/* Footer */}
      {approval.resolvedAt && (
        <p className="text-[11px] text-muted-foreground">
          {status.label} by {approval.resolvedBy} at {approval.resolvedAt}
        </p>
      )}
      {isPending && approval.expiresAt && (
        <p className="flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400">
          <Clock className="h-3 w-3" aria-hidden="true" />
          Expires {approval.expiresAt} — agent will cancel if not resolved
        </p>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ActivityApprovalsPage() {
  const pending = MOCK_APPROVALS.filter((a) => a.status === "pending");
  const resolved = MOCK_APPROVALS.filter((a) => a.status !== "pending");

  return (
    <div className="flex flex-col gap-5 max-w-2xl">
      {/* Preview pill */}
      <div className="flex items-center justify-end">
        <span className="inline-flex items-center gap-1 rounded-full border border-border/50 bg-muted/50 px-2.5 py-0.5 text-[11px] text-muted-foreground">
          <Info className="h-3 w-3" aria-hidden="true" />
          Preview · not yet wired to live data
        </span>
      </div>

      {/* Section heading */}
      <div className="flex items-start gap-3">
        <CheckSquare className="mt-0.5 h-5 w-5 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
        <div>
          <p className="text-sm font-semibold text-foreground">Approvals</p>
          <p className="text-xs text-muted-foreground">
            Human-in-the-loop queue for plan approvals and capabilities marked require-approval.
            Review, accept, or reject pending agent actions.
          </p>
        </div>
      </div>

      {/* Pending */}
      {pending.length > 0 ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" aria-hidden="true" />
            <span className="text-xs font-semibold text-amber-600 dark:text-amber-400">
              {pending.length} pending {pending.length === 1 ? "approval" : "approvals"}
            </span>
          </div>
          {pending.map((a) => (
            <ApprovalCard key={a.id} approval={a} />
          ))}
        </div>
      ) : (
        <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-4 py-3">
          <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">No pending approvals.</p>
        </div>
      )}

      {/* Resolved */}
      {resolved.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Resolved ({resolved.length})
            </span>
            <ChevronRight className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
          </div>
          {resolved.map((a) => (
            <ApprovalCard key={a.id} approval={a} />
          ))}
        </div>
      )}
    </div>
  );
}
